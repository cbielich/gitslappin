import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, type CommandLogEntry } from '../api';

const POLL_MS = 2000;
const KEEP = 1000;

interface Props {
  repoId: string;
  onClose: () => void;
}

/** The bottom "Activity Logs" panel. It exists only while open, so it polls only while open. Rows are text, never HTML. */
export function ActivityLog({ repoId, onClose }: Props) {
  const [entries, setEntries] = useState<CommandLogEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    let live = true;
    let busy = false;
    last.current = 0;
    setEntries([]);
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const res = await api.commandLog(repoId, last.current);
        if (!live) return;
        setFailed(false);
        if (res.entries.length > 0) {
          last.current = Math.max(last.current, ...res.entries.map((e) => e.seq));
          setEntries((old) => [...old, ...res.entries].slice(-KEEP));
        }
      } catch {
        if (live) setFailed(true);
      } finally {
        busy = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [repoId]);

  return (
    <section className="activity-log" data-testid="activity-log-panel">
      <header className="activity-log-header">
        <span className="activity-log-title" data-testid="activity-log-title">
          Activity Logs
        </span>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={12} />
        </button>
      </header>
      {failed && (
        <div className="activity-log-error" data-testid="activity-log-error">
          An error occurred while trying to load this log.
        </div>
      )}
      <div className="activity-log-rows">
        {[...entries].reverse().map((e) => (
          <div key={e.seq} className={`activity-log-row${e.code === 0 ? '' : ' failed'}`} data-testid="activity-log-row" data-seq={e.seq} data-code={e.code}>
            <span className="activity-log-time" data-testid="activity-log-time">
              {new Date(e.at).toLocaleTimeString()}
            </span>
            <span className="activity-log-args" data-testid="activity-log-args">
              {`git ${e.args.join(' ')}`}
            </span>
            <span className="activity-log-code" data-testid="activity-log-code">
              {e.code}
            </span>
            <span className="activity-log-duration" data-testid="activity-log-duration">
              {`${Math.round(e.durationMs)} ms`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
