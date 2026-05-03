import { describe, it, expect } from "vitest";
import {
  buildTemporalWebUrl,
  buildTimeline,
  decodePullRequestFromHistory,
  extractHumanPauses,
  failureToHumanPause,
  groupReviewRounds,
  normalizeAttemptCount,
  normalizeCurrentRound,
  normalizePhase,
  normalizeWorkflowStatus,
  workflowFailureToTerminal,
  type DecodedHistoryEvent,
} from "../../src/temporal/ticket-activity-normalize.js";

describe("normalizeWorkflowStatus", () => {
  it("maps Temporal status names to the domain enum", () => {
    expect(normalizeWorkflowStatus("RUNNING")).toBe("running");
    expect(normalizeWorkflowStatus("Completed")).toBe("completed");
    expect(normalizeWorkflowStatus("FAILED")).toBe("failed");
    expect(normalizeWorkflowStatus("CANCELED")).toBe("cancelled");
    expect(normalizeWorkflowStatus("CANCELLED")).toBe("cancelled");
    expect(normalizeWorkflowStatus("TERMINATED")).toBe("terminated");
    expect(normalizeWorkflowStatus("TIMED_OUT")).toBe("timed_out");
    expect(normalizeWorkflowStatus(undefined)).toBe("unknown");
    expect(normalizeWorkflowStatus("weird-status")).toBe("unknown");
  });
});

describe("normalizePhase / normalizeAttemptCount / normalizeCurrentRound", () => {
  it("accepts known phases and rejects unknowns", () => {
    expect(normalizePhase("queued")).toBe("queued");
    expect(normalizePhase("review")).toBe("review");
    expect(normalizePhase("garbage")).toBeUndefined();
    expect(normalizePhase(42)).toBeUndefined();
  });

  it("rejects negative or non-finite numbers", () => {
    expect(normalizeAttemptCount(0)).toBe(0);
    expect(normalizeAttemptCount(3)).toBe(3);
    expect(normalizeAttemptCount(-1)).toBeUndefined();
    expect(normalizeAttemptCount(Number.NaN)).toBeUndefined();
    expect(normalizeAttemptCount("3" as unknown)).toBeUndefined();
    expect(normalizeCurrentRound(2)).toBe(2);
    expect(normalizeCurrentRound(-2)).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  it("coalesces schedule + start + complete into a single entry", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "workflow-execution-started", workflowType: "perTicketWorkflow", timestamp: "2026-01-01T00:00:00Z" },
      { eventId: 5, type: "activity-task-scheduled", activityType: "runSpecPhase", timestamp: "2026-01-01T00:00:01Z" },
      { eventId: 6, type: "activity-task-started", scheduledEventId: 5, timestamp: "2026-01-01T00:00:02Z" },
      { eventId: 7, type: "activity-task-completed", scheduledEventId: 5, timestamp: "2026-01-01T00:00:03Z", output: { ok: true } },
    ];
    const tl = buildTimeline(events);
    expect(tl).toHaveLength(2);
    expect(tl[0].type).toBe("workflow-execution-started");
    expect(tl[1].type).toBe("runSpecPhase");
    expect(tl[1].status).toBe("completed");
    expect(tl[1].label).toBe("Spec phase");
    expect(tl[1].category).toBe("spec");
    expect(tl[1].details?.output).toEqual({ ok: true });
  });

  it("classifies known activity categories", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "runCoderPhase" },
      { eventId: 2, type: "activity-task-scheduled", activityType: "runReviewPhase" },
      { eventId: 3, type: "activity-task-scheduled", activityType: "openPullRequestActivity" },
      { eventId: 4, type: "activity-task-scheduled", activityType: "syncLinearTicketStateActivity" },
      { eventId: 5, type: "activity-task-scheduled", activityType: "launchWorkerContainer" },
      { eventId: 6, type: "activity-task-scheduled", activityType: "unfamiliarActivity" },
    ];
    const tl = buildTimeline(events);
    expect(tl.map((e) => e.category)).toEqual([
      "coder",
      "review",
      "github",
      "linear",
      "container",
      "other",
    ]);
  });

  it("renders cancellation, failure, and unknown events", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "runCoderPhase" },
      { eventId: 2, type: "activity-task-failed", scheduledEventId: 1, failure: { failureType: "Boom", message: "boom" } },
      { eventId: 3, type: "workflow-execution-cancel-requested" },
      { eventId: 4, type: "workflow-execution-canceled" },
      { eventId: 5, type: "workflow-execution-failed", failure: { failureType: "ApplicationFailure", message: "x" } },
      { eventId: 6, type: "unknown", rawType: "EVENT_TYPE_99" },
    ];
    const tl = buildTimeline(events);
    expect(tl[0].status).toBe("failed");
    expect(tl[0].details?.failure).toBeDefined();
    expect(tl[1].status).toBe("cancelled");
    expect(tl[1].category).toBe("signal");
    expect(tl[2].status).toBe("cancelled");
    expect(tl[3].status).toBe("failed");
    expect(tl[3].label).toContain("ApplicationFailure");
    expect(tl[4].status).toBe("unknown");
    expect(tl[4].type).toBe("EVENT_TYPE_99");
  });

  it("renders signals", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "workflow-execution-signaled", signalName: "answerClarification" },
    ];
    const tl = buildTimeline(events);
    expect(tl[0].label).toBe("Signal: answerClarification");
    expect(tl[0].category).toBe("signal");
  });
});

describe("decodePullRequestFromHistory", () => {
  it("returns the latest open-PR completion result", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "openPullRequestActivity" },
      {
        eventId: 2,
        type: "activity-task-completed",
        scheduledEventId: 1,
        output: { number: 11, url: "https://github.com/o/r/pull/11" },
      },
      { eventId: 3, type: "activity-task-scheduled", activityType: "openPullRequestActivity" },
      {
        eventId: 4,
        type: "activity-task-completed",
        scheduledEventId: 3,
        output: { number: 22, url: "https://github.com/o/r/pull/22" },
      },
    ];
    expect(decodePullRequestFromHistory(events)).toEqual({
      number: 22,
      url: "https://github.com/o/r/pull/22",
    });
  });

  it("returns undefined when no PR completion is present", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "openPullRequestActivity" },
      { eventId: 2, type: "activity-task-failed", scheduledEventId: 1 },
    ];
    expect(decodePullRequestFromHistory(events)).toBeUndefined();
  });

  it("ignores non-openPR activity completions", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "runCoderPhase" },
      { eventId: 2, type: "activity-task-completed", scheduledEventId: 1, output: { number: 99, url: "wrong" } },
    ];
    expect(decodePullRequestFromHistory(events)).toBeUndefined();
  });
});

describe("failureToHumanPause / extractHumanPauses", () => {
  it("walks the failure cause chain to find a known pause type", () => {
    const failure = {
      failureType: "ActivityFailure",
      message: "wrap",
      cause: {
        failureType: "AcClarificationRequested",
        message: "ask",
        details: [
          {
            subTicket: { id: "abc", identifier: "FUR-1", title: "Need info" },
          },
        ],
      },
    };
    const pause = failureToHumanPause(failure, "2026-01-02T00:00:00Z");
    expect(pause?.type).toBe("ac-clarification");
    expect(pause?.failureType).toBe("AcClarificationRequested");
    expect(pause?.subTicket).toEqual({
      id: "abc",
      identifier: "FUR-1",
      title: "Need info",
    });
    expect(pause?.occurredAt).toBe("2026-01-02T00:00:00Z");
  });

  it("decodes review-round-cap with review summary", () => {
    const pause = failureToHumanPause({
      failureType: "ReviewRoundCapExhausted",
      message: "cap",
      details: [
        {
          verdict: "request_changes",
          reasoning: "needs polish",
          findings: [{}, {}],
          prNumber: 7,
        },
      ],
    });
    expect(pause?.type).toBe("review-round-cap");
    expect(pause?.review).toEqual({
      verdict: "request_changes",
      reasoning: "needs polish",
      findingsCount: 2,
      prNumber: 7,
    });
  });

  it("returns undefined when no known pause type is in the chain", () => {
    expect(
      failureToHumanPause({
        failureType: "SomethingElse",
        message: "x",
      }),
    ).toBeUndefined();
  });

  it("collects pauses from history events and the terminal failure", () => {
    const events: DecodedHistoryEvent[] = [
      {
        eventId: 1,
        type: "activity-task-failed",
        scheduledEventId: 0,
        failure: { failureType: "DepMissingRequested", message: "need lib" },
        timestamp: "2026-01-02T00:00:00Z",
      },
    ];
    const terminal = { failureType: "DesignQuestionRequested", message: "?" };
    const pauses = extractHumanPauses(events, terminal);
    expect(pauses.map((p) => p.failureType)).toEqual([
      "DepMissingRequested",
      "DesignQuestionRequested",
    ]);
  });

  it("workflowFailureToTerminal returns generic shape for non-pause failures", () => {
    const tf = workflowFailureToTerminal({
      failureType: "ApplicationFailure",
      message: "boom",
    });
    expect(tf).toEqual({
      type: "workflow-failure",
      failureType: "ApplicationFailure",
      message: "boom",
    });
  });
});

describe("groupReviewRounds", () => {
  it("groups review attempts and pairs PR review posts by index", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 10, type: "activity-task-scheduled", activityType: "runReviewPhase", input: { round: 0 } },
      {
        eventId: 11,
        type: "activity-task-completed",
        scheduledEventId: 10,
        output: { verdict: "request_changes", reasoning: "fix bug", findings: [{}, {}] },
      },
      { eventId: 12, type: "activity-task-scheduled", activityType: "postPullRequestReviewActivity" },
      { eventId: 13, type: "activity-task-completed", scheduledEventId: 12 },
      { eventId: 20, type: "activity-task-scheduled", activityType: "runReviewPhase", input: { round: 1 } },
      {
        eventId: 21,
        type: "activity-task-completed",
        scheduledEventId: 20,
        output: { verdict: "approve", findings: [] },
      },
      { eventId: 22, type: "activity-task-scheduled", activityType: "postPullRequestReviewActivity" },
      { eventId: 23, type: "activity-task-failed", scheduledEventId: 22 },
    ];
    const rounds = groupReviewRounds(events);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({
      round: 0,
      status: "completed",
      verdict: "request_changes",
      findingsCount: 2,
      prPostStatus: "completed",
    });
    expect(rounds[1]).toMatchObject({
      round: 1,
      verdict: "approve",
      findingsCount: 0,
      prPostStatus: "failed",
    });
  });

  it("infers round index from order when input does not specify", () => {
    const events: DecodedHistoryEvent[] = [
      { eventId: 1, type: "activity-task-scheduled", activityType: "runReviewPhase" },
      { eventId: 2, type: "activity-task-scheduled", activityType: "runReviewPhase" },
    ];
    const rounds = groupReviewRounds(events);
    expect(rounds.map((r) => r.round)).toEqual([0, 1]);
  });
});

describe("buildTemporalWebUrl", () => {
  it("builds a deep link with namespace and workflow id", () => {
    expect(
      buildTemporalWebUrl("http://localhost:8233", "default", "ticket-1"),
    ).toBe("http://localhost:8233/namespaces/default/workflows/ticket-1");
  });

  it("includes runId when provided", () => {
    expect(
      buildTemporalWebUrl("http://localhost:8233/", "default", "ticket-1", "abc"),
    ).toBe("http://localhost:8233/namespaces/default/workflows/ticket-1/abc");
  });

  it("returns undefined when base is empty or undefined", () => {
    expect(buildTemporalWebUrl(undefined, "default", "ticket-1")).toBeUndefined();
    expect(buildTemporalWebUrl("", "default", "ticket-1")).toBeUndefined();
    expect(buildTemporalWebUrl("   ", "default", "ticket-1")).toBeUndefined();
  });
});
