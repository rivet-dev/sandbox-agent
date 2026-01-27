import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { UniversalEvent } from "sandbox-agent";
import { formatJson, formatTime } from "../../utils/format";
import { getEventCategory, getEventClass, getEventIcon, getEventKey, getEventType } from "./eventUtils";

const EventsTab = ({
  events,
  offset,
  onFetch,
  onClear,
  loading,
  error
}: {
  events: UniversalEvent[];
  offset: number;
  onFetch: () => void;
  onClear: () => void;
  loading: boolean;
  error: string | null;
}) => {
  const [collapsedEvents, setCollapsedEvents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (events.length === 0) {
      setCollapsedEvents({});
    }
  }, [events.length]);

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <span className="card-meta">Offset: {offset}</span>
        <div className="inline-row">
          <button className="button ghost small" onClick={onFetch} disabled={loading}>
            {loading ? "Loading..." : "Fetch"}
          </button>
          <button className="button ghost small" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {events.length === 0 ? (
        <div className="card-meta">
          {loading ? "Loading events..." : "No events yet. Start streaming to receive events."}
        </div>
      ) : (
        <div className="event-list">
          {[...events].reverse().map((event) => {
            const type = getEventType(event);
            const category = getEventCategory(type);
            const eventClass = `${category} ${getEventClass(type)}`;
            const eventKey = getEventKey(event);
            const isCollapsed = collapsedEvents[eventKey] ?? true;
            const toggleCollapsed = () =>
              setCollapsedEvents((prev) => ({
                ...prev,
                [eventKey]: !(prev[eventKey] ?? true)
              }));
            const Icon = getEventIcon(type);
            return (
              <div key={eventKey} className={`event-item ${isCollapsed ? "collapsed" : "expanded"}`}>
                <button
                  className="event-summary"
                  type="button"
                  onClick={toggleCollapsed}
                  title={isCollapsed ? "Expand payload" : "Collapse payload"}
                >
                  <span className={`event-icon ${eventClass}`}>
                    <Icon size={14} />
                  </span>
                  <div className="event-summary-main">
                    <div className="event-title-row">
                      <span className={`event-type ${eventClass}`}>{type}</span>
                      <span className="event-time">{formatTime(event.time)}</span>
                    </div>
                    <div className="event-id">
                      Event #{event.event_id || event.sequence} - seq {event.sequence} - {event.source}
                      {event.synthetic ? " (synthetic)" : ""}
                    </div>
                  </div>
                  <span className="event-chevron">
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>
                {!isCollapsed && <pre className="code-block event-payload">{formatJson(event.data)}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

export default EventsTab;
