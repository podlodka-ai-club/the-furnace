import type { ReviewRoundSummary } from "../../../src/temporal/ticket-activity-types.js";

export interface ReviewRoundsPanelProps {
  rounds: ReviewRoundSummary[];
}

export function ReviewRoundsPanel({ rounds }: ReviewRoundsPanelProps) {
  return (
    <div role="list">
      {rounds.map((round) => (
        <div className="review-round" role="listitem" key={`${round.round}:${round.attemptId ?? round.startedAt ?? ""}`}>
          <div className="review-round__header">
            <span>Round {round.round}</span>
            {round.verdict ? (
              <span className={`review-round__verdict verdict-${round.verdict}`}>
                {round.verdict.replace("_", " ")}
              </span>
            ) : (
              <span className={`status-pill status-${round.status}`}>{round.status}</span>
            )}
          </div>
          {round.reasoning ? (
            <p style={{ margin: "6px 0", color: "#c9d1d9" }}>{round.reasoning}</p>
          ) : null}
          <div style={{ color: "#8b949e", fontSize: 12 }}>
            {round.findingsCount !== undefined ? `${round.findingsCount} findings · ` : ""}
            {round.prNumber !== undefined ? `PR #${round.prNumber}` : ""}
            {round.prPostStatus ? ` · review ${round.prPostStatus}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
