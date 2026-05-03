import type {
  HumanPause,
  TerminalFailure,
} from "../../../src/temporal/ticket-activity-types.js";

export interface HumanPausePanelProps {
  pauses: Array<HumanPause | TerminalFailure>;
}

const TYPE_LABELS: Record<string, string> = {
  "ac-clarification": "AC Clarification Needed",
  "dep-missing": "Missing Dependency",
  "design-question": "Design Question",
  "review-round-cap": "Review Round Cap Exhausted",
  "workflow-failure": "Workflow Failure",
};

export function HumanPausePanel({ pauses }: HumanPausePanelProps) {
  return (
    <div role="list">
      {pauses.map((pause, idx) => {
        const isHumanPause = "type" in pause && pause.type !== "workflow-failure";
        const typeKey = "type" in pause ? pause.type : "workflow-failure";
        const label = TYPE_LABELS[typeKey] ?? typeKey;
        const failureType =
          "failureType" in pause && pause.failureType
            ? pause.failureType
            : undefined;
        return (
          <div
            className="human-pause"
            role="listitem"
            key={`${typeKey}:${idx}`}
            data-failure-type={failureType}
          >
            <div className="human-pause__type">{label}</div>
            {pause.message ? <div>{pause.message}</div> : null}
            {isHumanPause && "subTicket" in pause && pause.subTicket ? (
              <div style={{ marginTop: 6, color: "#c9d1d9", fontSize: 12 }}>
                Sub-ticket:{" "}
                <strong>{pause.subTicket.identifier ?? pause.subTicket.id ?? "—"}</strong>
                {pause.subTicket.title ? ` — ${pause.subTicket.title}` : ""}
              </div>
            ) : null}
            {isHumanPause && "review" in pause && pause.review ? (
              <div style={{ marginTop: 6, color: "#c9d1d9", fontSize: 12 }}>
                {pause.review.verdict ? `Verdict: ${pause.review.verdict}` : ""}
                {pause.review.findingsCount !== undefined
                  ? ` · ${pause.review.findingsCount} findings`
                  : ""}
                {pause.review.prNumber !== undefined ? ` · PR #${pause.review.prNumber}` : ""}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
