// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkflowList } from "../../ui/src/components/WorkflowList.js";
import { WorkflowDetail } from "../../ui/src/components/WorkflowDetail.js";
import { Timeline } from "../../ui/src/components/Timeline.js";
import { ReviewRoundsPanel } from "../../ui/src/components/ReviewRoundsPanel.js";
import { HumanPausePanel } from "../../ui/src/components/HumanPausePanel.js";
import type {
  HumanPause,
  ReviewRoundSummary,
  TicketWorkflowDetail,
  TicketWorkflowSummary,
  TimelineEvent,
} from "../../src/temporal/ticket-activity-types.js";

const summary: TicketWorkflowSummary = {
  workflowId: "ticket-FUR-1",
  runId: "run-1",
  status: "running",
  ticketIdentifier: "FUR-1",
  title: "Add login flow",
  startedAt: new Date(Date.now() - 5_000).toISOString(),
};

describe("WorkflowList", () => {
  it("renders summaries with status pill", () => {
    render(
      <WorkflowList
        workflows={[summary]}
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText("FUR-1")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("Add login flow")).toBeInTheDocument();
  });

  it("shows empty state when no workflows", () => {
    render(
      <WorkflowList
        workflows={[]}
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText(/No ticket workflows found/i)).toBeInTheDocument();
  });

  it("shows loading state", () => {
    render(
      <WorkflowList
        workflows={[]}
        onSelect={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByText(/Loading workflows/i)).toBeInTheDocument();
  });

  it("shows error state when no data", () => {
    render(
      <WorkflowList
        workflows={[]}
        onSelect={() => {}}
        loading={false}
        error="Temporal unreachable"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Temporal unreachable");
  });
});

describe("WorkflowDetail", () => {
  const detail: TicketWorkflowDetail = {
    ...summary,
    targetRepoSlug: "acme/repo",
    phase: "review",
    attemptCount: 2,
    currentRound: 1,
    pr: { number: 42, url: "https://github.com/acme/repo/pull/42" },
    timeline: [],
    reviewRounds: [],
    humanPauses: [],
    temporalWebUrl: "http://localhost:8233/workflows/ticket-FUR-1",
  };

  it("renders the compact header with PR + Temporal Web links", () => {
    render(
      <WorkflowDetail
        detail={detail}
        loading={false}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(screen.getByText("FUR-1")).toBeInTheDocument();
    expect(screen.getByText("Add login flow")).toBeInTheDocument();
    expect(screen.getByText("acme/repo")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("#42 ↗").closest("a")).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
    expect(screen.getByText("Temporal Web ↗").closest("a")).toHaveAttribute(
      "href",
      "http://localhost:8233/workflows/ticket-FUR-1",
    );
  });

  it("shows loading without detail", () => {
    render(
      <WorkflowDetail
        detail={undefined}
        loading={true}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(screen.getByText(/Loading workflow/i)).toBeInTheDocument();
  });

  it("shows empty state when no detail and not loading", () => {
    render(
      <WorkflowDetail
        detail={undefined}
        loading={false}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(screen.getByText(/Select a ticket workflow/i)).toBeInTheDocument();
  });

  it("does not render mutating controls", () => {
    render(
      <WorkflowDetail
        detail={detail}
        loading={false}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    const buttons = screen.getAllByRole("button");
    // The only button should be the refresh button.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("aria-label", "Refresh");
  });
});

describe("Timeline", () => {
  it("renders events with status classes", () => {
    const events: TimelineEvent[] = [
      {
        id: "evt-1",
        eventId: 1,
        type: "runSpecPhase",
        label: "Spec phase",
        status: "completed",
        category: "spec",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "evt-2",
        eventId: 2,
        type: "EVENT_TYPE_99",
        label: "Unknown event",
        status: "unknown",
        category: "other",
      },
    ];
    render(<Timeline events={events} />);
    expect(screen.getByText("Spec phase")).toBeInTheDocument();
    expect(screen.getByText("Unknown event")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows empty state when no events", () => {
    render(<Timeline events={[]} />);
    expect(screen.getByText(/No timeline events recorded/i)).toBeInTheDocument();
  });
});

describe("ReviewRoundsPanel", () => {
  it("renders rounds with verdict and findings", () => {
    const rounds: ReviewRoundSummary[] = [
      {
        round: 0,
        status: "completed",
        verdict: "approve",
        findingsCount: 0,
      },
      {
        round: 1,
        status: "completed",
        verdict: "request_changes",
        reasoning: "needs polish",
        findingsCount: 3,
        prNumber: 42,
        prPostStatus: "completed",
      },
    ];
    render(<ReviewRoundsPanel rounds={rounds} />);
    expect(screen.getByText("Round 0")).toBeInTheDocument();
    expect(screen.getByText("approve")).toBeInTheDocument();
    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getByText("request changes")).toBeInTheDocument();
    expect(screen.getByText(/needs polish/)).toBeInTheDocument();
    expect(screen.getByText(/3 findings/)).toBeInTheDocument();
  });
});

describe("HumanPausePanel", () => {
  it("renders pauses with sub-ticket", () => {
    const pauses: HumanPause[] = [
      {
        type: "ac-clarification",
        failureType: "AcClarificationRequested",
        message: "Need clarification on auth flow",
        subTicket: { identifier: "FUR-2", title: "Clarify auth" },
      },
    ];
    render(<HumanPausePanel pauses={pauses} />);
    expect(screen.getByText("AC Clarification Needed")).toBeInTheDocument();
    expect(screen.getByText(/Need clarification on auth flow/i)).toBeInTheDocument();
    expect(screen.getByText("FUR-2")).toBeInTheDocument();
  });
});
