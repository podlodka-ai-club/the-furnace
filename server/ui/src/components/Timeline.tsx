import type { TimelineEvent } from "../../../src/temporal/ticket-activity-types.js";

export interface TimelineProps {
  events: TimelineEvent[];
}

export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return <div className="empty-state">No timeline events recorded.</div>;
  }
  return (
    <div className="timeline" role="list">
      {events.map((ev) => (
        <div
          key={ev.id}
          className={`timeline__item status-${ev.status}`}
          role="listitem"
          data-event-id={ev.eventId}
        >
          <span className="timeline__time">{formatEventTime(ev.timestamp)}</span>
          <span className="timeline__label">
            <strong>{ev.label}</strong>
            <span style={{ color: "#8b949e", marginLeft: 8 }}>{ev.type}</span>
          </span>
          <span className="timeline__status">{ev.status}</span>
        </div>
      ))}
    </div>
  );
}

function formatEventTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString();
}
