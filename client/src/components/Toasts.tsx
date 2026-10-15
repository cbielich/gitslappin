export interface Toast {
  id: number;
  title: string;
  /** git's output for the failure (text only). */
  detail: string;
}

/** Failure toasts. They stay until dismissed. All text goes in as text nodes. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-testid="toast" role="alert">
          <div className="toast-title" data-testid="toast-title">
            {t.title}
          </div>
          <pre className="toast-detail" data-testid="toast-detail">
            {t.detail}
          </pre>
          <button className="toast-dismiss" data-testid="toast-dismiss" onClick={() => onDismiss(t.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
