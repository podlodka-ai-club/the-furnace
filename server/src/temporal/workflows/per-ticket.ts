import {
  ActivityFailure,
  ApplicationFailure,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  CoderPhaseOutput,
  Finding,
  PriorReview,
  ReviewResult,
  ReviewerInput,
  ReviewerTicket,
  SpecPhaseOutput,
} from "../../agents/contracts/index.js";
import type * as githubActivities from "../activities/github.js";
import type * as linearActivities from "../activities/linear.js";
import type * as workerLauncherActivities from "../activities/worker-launcher.js";
import type { LaunchWorkerContainerResult } from "../activities/worker-launcher.js";
import { MAX_REVIEW_ROUNDS, PHASE_MAX_ATTEMPTS, phaseActivitiesForRepo } from "../dispatch.js";
import { formatDiffSummary } from "../../github/trailers.js";

const SPEC_AC_CLARIFICATION_FAILURE_TYPE = "AcClarificationRequested";
const CODER_DEP_MISSING_FAILURE_TYPE = "DepMissingRequested";
const CODER_DESIGN_QUESTION_FAILURE_TYPE = "DesignQuestionRequested";

export const REVIEW_ROUND_CAP_EXHAUSTED_FAILURE_TYPE = "ReviewRoundCapExhausted";

export const PER_TICKET_WORKFLOW_NAME = "perTicketWorkflow";

export type PerTicketWorkflowPhase =
  | "queued"
  | "spec"
  | "coder"
  | "review"
  | "completed"
  | "cancelled";

export interface PerTicketWorkflowInput {
  ticket: ReviewerTicket;
  // Required: identifies which per-repo task queue to dispatch phase activities
  // to and which container image to launch. See container-worker-lifecycle spec.
  targetRepoSlug: string;
  // Optional override for the workflow-local cap on coder ↔ reviewer iteration
  // rounds. Used by integration tests that need to force cap exhaustion without
  // touching `MAX_REVIEW_ROUNDS`. Falls back to the dispatch constant.
  maxReviewRounds?: number;
}

export interface PerTicketWorkflowResult {
  status: "succeeded" | "cancelled";
  pr?: { number: number; url: string };
}

export const cancelSignal = defineSignal("cancel");
export const currentPhaseQuery = defineQuery<PerTicketWorkflowPhase>("currentPhase");
export const attemptCountQuery = defineQuery<number>("attemptCount");
export const currentRoundQuery = defineQuery<number>("currentRound");

const { syncLinearTicketStateActivity } = proxyActivities<typeof linearActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

const { launchWorkerContainer } = proxyActivities<typeof workerLauncherActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

const { validateRepoSlug } = proxyActivities<typeof workerLauncherActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumAttempts: 1,
  },
});

const { openPullRequestActivity, postPullRequestReviewActivity } = proxyActivities<
  typeof githubActivities
>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

export async function perTicketWorkflow(
  input: PerTicketWorkflowInput,
): Promise<PerTicketWorkflowResult> {
  let currentPhase: PerTicketWorkflowPhase = "queued";
  let attemptCount = 0;
  let currentRound = 0;
  let cancelled = false;

  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(currentPhaseQuery, () => currentPhase);
  setHandler(attemptCountQuery, () => attemptCount);
  setHandler(currentRoundQuery, () => currentRound);

  // Defense-in-depth: the Linear client now guarantees a non-empty slug at the
  // producer boundary (see linear-target-repo-resolution change), so this check
  // is dead code on the linear-poller path. It still guards manual workflow
  // starts that bypass the Linear client.
  if (!input.targetRepoSlug || input.targetRepoSlug.trim().length === 0) {
    throw ApplicationFailure.nonRetryable(
      "perTicketWorkflow requires targetRepoSlug; got empty value",
      "InvalidWorkflowInput",
    );
  }

  const maxReviewRounds = input.maxReviewRounds ?? MAX_REVIEW_ROUNDS;
  if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) {
    throw ApplicationFailure.nonRetryable(
      `perTicketWorkflow maxReviewRounds must be a positive integer; got ${maxReviewRounds}`,
      "InvalidWorkflowInput",
    );
  }

  // Fail fast if the slug is unknown — surfaces UnknownRepoSlugError before
  // any container launch.
  await validateRepoSlug({ slug: input.targetRepoSlug });

  const { runSpecPhase, runCoderPhase, runReviewPhase } = phaseActivitiesForRepo(
    input.targetRepoSlug,
  );

  await syncLinearTicketStateActivity({
    ticketId: input.ticket.id,
    stateName: "In Progress",
  });

  const specOutput = await runSpecPhaseWithRecording();
  if (specOutput === null) {
    return { status: "cancelled" };
  }

  let pr: { number: number; url: string } | undefined;
  let priorReview: PriorReview | undefined;
  let lastReview: ReviewResult | undefined;

  for (let round = 0; round < maxReviewRounds; round += 1) {
    currentRound = round;

    if (cancelled) {
      await transitionToCancelled();
      return { status: "cancelled" };
    }

    // Stuck-failures (DepMissingRequested, DesignQuestionRequested) propagate
    // out of runPhase without retrying. The workflow does NOT sync the Linear
    // ticket to "Canceled" — it stays "In Progress" so a human can resolve
    // the sub-ticket and the orchestrator re-enqueues from `agent-ready`. The
    // structured failure detail (`subTicketRef`) is preserved in Temporal's
    // workflow event history via the rethrown ApplicationFailure.
    const coderOutput: CoderPhaseOutput | null = await runPhase(
      "coder",
      () => runCoderPhase({ ticket: input.ticket, specOutput, priorReview }),
      {
        stuckFailureTypes: [
          CODER_DEP_MISSING_FAILURE_TYPE,
          CODER_DESIGN_QUESTION_FAILURE_TYPE,
        ],
      },
    );
    if (coderOutput === null) {
      return { status: "cancelled" };
    }

    // Open the PR exactly once, after the round-0 coder phase. Subsequent
    // rounds reuse the same PR number and post follow-up reviews against it.
    if (round === 0) {
      pr = await openPullRequestActivity({
        featureBranch: coderOutput.featureBranch,
        targetRepoSlug: input.targetRepoSlug,
        ticket: input.ticket,
        workflowId: workflowInfo().workflowId,
        attemptCount,
        finalCommitSha: coderOutput.finalCommitSha,
        diffSummary: formatDiffSummary(coderOutput.diffStat),
      });
    }
    if (!pr) {
      throw ApplicationFailure.nonRetryable(
        "internal: PR reference missing after round-0 openPullRequestActivity",
        "InvalidWorkflowState",
      );
    }

    const reviewerInput: ReviewerInput = {
      ticket: input.ticket,
      featureBranch: coderOutput.featureBranch,
      finalCommitSha: coderOutput.finalCommitSha,
      diffStat: coderOutput.diffStat,
      testRunSummary: coderOutput.testRunSummary,
      prNumber: pr.number,
      round,
    };
    // Pass `cancelAfterSuccess: false` so that if cancel arrives during or just
    // after the review activity, we still receive the verdict and post it. The
    // "post after every review round" audit contract is stronger than racing
    // cancellation; the cancel transition happens at the top of the next loop
    // iteration.
    const reviewOutput = await runPhase("review", () => runReviewPhase(reviewerInput), {
      cancelAfterSuccess: false,
    });
    if (reviewOutput === null) {
      return { status: "cancelled" };
    }
    lastReview = reviewOutput;

    const inlineComments = reviewOutput.findings
      .filter((f: Finding) => f.line !== undefined)
      .map((f: Finding) => ({
        path: f.path,
        line: f.line as number,
        body: `[${f.severity}] ${f.message}`,
      }));
    const topLevelFindings = reviewOutput.findings.filter(
      (f: Finding) => f.line === undefined,
    );
    const reviewBody =
      topLevelFindings.length > 0
        ? `${reviewOutput.reasoning}\n\n## Additional findings\n\n${topLevelFindings
            .map((f: Finding) => `- [${f.severity}] \`${f.path}\`: ${f.message}`)
            .join("\n")}`
        : reviewOutput.reasoning;

    await postPullRequestReviewActivity({
      targetRepoSlug: input.targetRepoSlug,
      prNumber: pr.number,
      verdict: reviewOutput.verdict,
      body: reviewBody,
      comments: inlineComments,
    });

    if (reviewOutput.verdict === "approve") {
      currentPhase = "completed";
      await syncLinearTicketStateActivity({
        ticketId: input.ticket.id,
        stateName: "Done",
      });
      return { status: "succeeded", pr };
    }

    priorReview = {
      prNumber: pr.number,
      reviewSummary: reviewOutput.reasoning,
      findings: reviewOutput.findings,
    };
  }

  throw ApplicationFailure.nonRetryable(
    `Review round cap of ${maxReviewRounds} exhausted without approval`,
    REVIEW_ROUND_CAP_EXHAUSTED_FAILURE_TYPE,
    {
      verdict: lastReview?.verdict,
      reasoning: lastReview?.reasoning,
      findings: lastReview?.findings,
      prNumber: pr?.number,
    },
  );

  async function runSpecPhaseWithRecording(): Promise<SpecPhaseOutput | null> {
    return await runPhase("spec", () => runSpecPhase({ ticket: input.ticket }), {
      stuckFailureTypes: [SPEC_AC_CLARIFICATION_FAILURE_TYPE],
    });
  }

  // Per concept §3.6, every retry of a phase activity must run in a fresh
  // container. The per-attempt container worker shuts down after a single
  // activity settles (see worker-entry.ts > singleTaskActivity), so
  // activity-level retries would re-queue onto a dead worker. Retry
  // orchestration therefore lives here: each loop iteration launches a fresh
  // container and dispatches the phase activity once.
  //
  // Failures whose `ApplicationFailure.type` is in `stuckFailureTypes` skip
  // the retry loop and propagate up so the workflow can convert them into
  // Linear sub-tickets without spending retry budget.
  async function runPhase<T>(
    phase: "spec" | "coder" | "review",
    fn: () => Promise<T>,
    options: {
      stuckFailureTypes?: readonly string[];
      // When false, do NOT honor cancellation that arrives during/just after a
      // successful activity — return the output and let the caller act on it
      // before transitioning to cancelled. Used by the review phase to ensure
      // the verdict is always posted to the PR.
      cancelAfterSuccess?: boolean;
    } = {},
  ): Promise<T | null> {
    const stuckTypes = options.stuckFailureTypes ?? [];
    const cancelAfterSuccess = options.cancelAfterSuccess !== false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= PHASE_MAX_ATTEMPTS; attempt += 1) {
      if (cancelled) {
        await transitionToCancelled();
        return null;
      }

      currentPhase = phase;
      attemptCount += 1;

      const launch: LaunchWorkerContainerResult = await launchWorkerContainer({
        ticketId: input.ticket.id,
        phase,
        attemptId: `${workflowInfo().workflowId}:${phase}:${attemptCount}`,
        repoSlug: input.targetRepoSlug,
      });
      void launch;

      try {
        const output = await fn();

        if (cancelAfterSuccess && cancelled) {
          await transitionToCancelled();
          return null;
        }

        return output;
      } catch (err) {
        if (stuckTypes.some((t) => matchFailureType(err, t))) {
          throw err;
        }
        if (isNonRetryableFailure(err)) {
          throw err;
        }
        lastError = err;
        // Loop body re-launches a fresh container on the next iteration.
      }
    }
    throw lastError;
  }

  async function transitionToCancelled(): Promise<void> {
    currentPhase = "cancelled";
    await syncLinearTicketStateActivity({
      ticketId: input.ticket.id,
      stateName: "Canceled",
    });
  }
}

export function buildPerTicketWorkflowId(ticketId: string): string {
  return `ticket-${ticketId}`;
}

// Activities that throw `ApplicationFailure.nonRetryable(..., type, details)`
// surface in workflows as `ActivityFailure` with `cause` set to the
// `ApplicationFailure`. We also accept a bare `ApplicationFailure` for
// completeness (e.g. when the failure originates from inside a child workflow
// or is rethrown manually).
// An activity that throws `ApplicationFailure.nonRetryable(...)` surfaces in
// the workflow as `ActivityFailure` with `cause` set to the non-retryable
// `ApplicationFailure`. The workflow-level retry loop must honor that flag —
// otherwise we'd re-launch a container only to repeat a failure the activity
// has already declared terminal.
function isNonRetryableFailure(err: unknown): boolean {
  if (err instanceof ApplicationFailure) {
    return err.nonRetryable === true;
  }
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure) {
      return cause.nonRetryable === true;
    }
  }
  return false;
}

function matchFailureType(err: unknown, type: string): boolean {
  if (err instanceof ApplicationFailure && err.type === type) {
    return true;
  }
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure && cause.type === type) {
      return true;
    }
  }
  return false;
}

export type { CoderPhaseOutput, SpecPhaseOutput };
