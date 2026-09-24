import type { RouteLogEntry } from '../../../shared/ipc';

interface Props {
  entries: RouteLogEntry[];
  hasProject: boolean;
  onClose: () => void;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Side panel listing every routed message (composer sends and selection forwards), newest first. */
export function RoutingLog({ entries, hasProject, onClose }: Props) {
  return (
    <aside className="routing-log" aria-label="Routing log">
      <div className="routing-log-header">
        <span>Routing log</span>
        <span className="count">{entries.length}</span>
        <span className="spacer" />
        <button type="button" title="Hide routing log" aria-label="Hide routing log" onClick={onClose}>
          <i className="ri-close-line" aria-hidden="true" />
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="routing-log-empty">
          {hasProject ? 'No routed messages yet.' : 'Open a project to record routed messages.'}
        </div>
      ) : (
        <ol className="routing-log-list">
          {entries.map((e) => (
            <li key={e.id} className={`route ${e.kind}`}>
              <div className="route-meta">
                <span className="route-from">{e.fromLabel}</span>
                <span className="route-arrow">→</span>
                <span className="route-to">{e.targets.map((t) => `@${t}`).join(' ')}</span>
                <span className="spacer" />
                <time dateTime={new Date(e.createdAt).toISOString()} title={new Date(e.createdAt).toISOString()}>
                  {formatTime(e.createdAt)}
                </time>
              </div>
              <div className="route-preview">{e.preview || <em>(empty)</em>}</div>
              <div className="route-foot">
                {e.kind === 'forward' ? 'selection' : 'composer'} · {formatBytes(e.bytes)}
                {e.viaFile ? ' · via temp file' : ''}
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
