import type { ReactNode } from "react";
import type {
  TicketWorkflowDetail,
} from "../../../src/temporal/ticket-activity-types.js";
import { formatTimestamp } from "../format";
import { Timeline } from "./Timeline";
import { ReviewRoundsPanel } from "./ReviewRoundsPanel";
import { HumanPausePanel } from "./HumanPausePanel";

export interface WorkflowDetailProps {
  detail?: TicketWorkflowDetail;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  refreshing: boolean;
}

export function WorkflowDetail(props: WorkflowDetailProps) {
  const { detail, loading, error, onRefresh, refreshing } = props;

  if (loading && !detail) {
    return <div className="workflow-detail loading-state">Loading workflow…</div>;
  }

  if (error && !detail) {
    return (
      <div className="workflow-detail error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="workflow-detail empty-state">
        Select a ticket workflow from the list to view its activity.
      </div>
    );
  }

  return (
    <div className="workflow-detail">
      <div className="detail-header">
        <h1>
          {detail.ticketIdentifier ?? detail.workflowId.replace(/^ticket-/, "")}
        </h1>
        <span className={`status-pill status-${detail.status}`}>{detail.status}</span>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {detail.temporalWebUrl ? (
          <a
            href={detail.temporalWebUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Temporal Web ↗
          </a>
        ) : null}
      </div>
      {detail.title ? <div className="detail-grid__value">{detail.title}</div> : null}

      <div className="detail-grid">
        <DetailField label="Workflow Id" value={detail.workflowId} />
        <DetailField label="Run Id" value={detail.runId} />
        <DetailField label="Target Repo" value={detail.targetRepoSlug ?? "—"} />
        <DetailField label="Phase" value={detail.phase ?? "—"} />
        <DetailField
          label="Attempts"
          value={detail.attemptCount !== undefined ? String(detail.attemptCount) : "—"}
        />
        <DetailField
          label="Round"
          value={detail.currentRound !== undefined ? String(detail.currentRound) : "—"}
        />
        <DetailField label="Started" value={formatTimestamp(detail.startedAt)} />
        <DetailField label="Closed" value={formatTimestamp(detail.closedAt)} />
        <DetailField
          label="PR"
          value={
            detail.pr ? (
              <a href={detail.pr.url} target="_blank" rel="noreferrer noopener">
                #{detail.pr.number} ↗
              </a>
            ) : (
              "—"
            )
          }
        />
      </div>

      {error ? (
        <div className="error-state" role="alert">
          {error}
        </div>
      ) : null}

      {detail.humanPauses.length > 0 ? (
        <section className="section">
          <h2>Human Pauses</h2>
          <HumanPausePanel pauses={detail.humanPauses} />
        </section>
      ) : null}

      {detail.terminalFailure ? (
        <section className="section">
          <h2>Terminal Failure</h2>
          <HumanPausePanel pauses={[detail.terminalFailure as never]} />
        </section>
      ) : null}

      {detail.reviewRounds.length > 0 ? (
        <section className="section">
          <h2>Review Attempts</h2>
          <ReviewRoundsPanel rounds={detail.reviewRounds} />
        </section>
      ) : null}

      <section className="section">
        <h2>Activity Timeline</h2>
        <Timeline events={detail.timeline} />
      </section>
    </div>
  );
}

function DetailField(props: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="detail-grid__label">{props.label}</div>
      <div className="detail-grid__value">{props.value}</div>
    </div>
  );
}
