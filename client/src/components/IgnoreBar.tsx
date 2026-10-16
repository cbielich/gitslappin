import { useEffect } from 'react';

interface Props {
  message: string;
  onIgnore: () => void;
  onIgnoreUntrack: () => void;
  onCancel: () => void;
}

/** The confirm bar for a tracked target (PromptIgnore-Message, PromptIgnore-Ignore, PromptIgnore-IgnoreAndUntrack, CancelButtonLabel). Escape cancels. */
export function IgnoreBar({ message, onIgnore, onIgnoreUntrack, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="confirm-bar" data-testid="confirm-bar" data-kind="ignore" role="alertdialog">
      <span className="confirm-text">
        <span data-testid="confirm-message">{message}</span>
      </span>
      <button className="confirm-ok" data-testid="confirm-ignore" onClick={onIgnore}>
        Ignore
      </button>
      <button className="confirm-ok" data-testid="confirm-ignore-untrack" onClick={onIgnoreUntrack}>
        Ignore and Stop Tracking
      </button>
      <button className="confirm-cancel" data-testid="confirm-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
