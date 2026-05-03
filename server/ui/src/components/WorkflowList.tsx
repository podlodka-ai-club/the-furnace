import type { TicketWorkflowSummary } from "../../../src/temporal/ticket-activity-types.js";
import { formatRelativeTime } from "../format";

export interface WorkflowListProps {
  workflows: TicketWorkflowSummary[];
  selectedWorkflowId?: string;
  onSelect: (workflow: TicketWorkflowSummary) => void;
  loading: boolean;
  error?: string;
}

export function WorkflowList(props: WorkflowListProps) {
  const { workflows, selectedWorkflowId, onSelect, loading, error } = props;

  if (loading && workflows.length === 0) {
    return (
      <div className="workflow-list">
        <div className="loading-state">Loading workflows…</div>
      </div>
    );
  }

  if (error && workflows.length === 0) {
    return (
      <div className="workflow-list">
        <div className="error-state" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="workflow-list">
        <div className="empty-state">No ticket workflows found.</div>
      </div>
    );
  }

  return (
    <div className="workflow-list" role="list">
      {workflows.map((wf) => {
        const isSelected = wf.workflowId === selectedWorkflowId;
        const className = `workflow-list__item${isSelected ? " is-selected" : ""}`;
        const titleLabel =
          wf.ticketIdentifier ?? wf.workflowId.replace(/^ticket-/, "");
        return (
          <div
            key={`${wf.workflowId}:${wf.runId}`}
            className={className}
            role="listitem"
            tabIndex={0}
            onClick={() => onSelect(wf)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(wf);
              }
            }}
          >
            <div className="workflow-list__title">
              <span>{titleLabel}</span>
              <span className={`status-pill status-${wf.status}`}>{wf.status}</span>
            </div>
            <div className="workflow-list__meta">
              {wf.title ?? wf.workflowId}
            </div>
            <div className="workflow-list__meta">
              {wf.phase ? `phase: ${wf.phase}` : ""}
              {wf.startedAt ? ` · ${formatRelativeTime(wf.startedAt)}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
