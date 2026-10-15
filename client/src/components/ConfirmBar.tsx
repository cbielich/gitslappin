import { useEffect } from 'react';

interface Props {
  message: string;
  /** Label of the destructive-looking OK button (e.g. DeleteButtonLabel). */
  okLabel: string;
  cancelLabel?: string;
  /** Which question this is (`data-kind`), for the destructive actions of phase 11. */
  kind?: string;
  /** git's own words under the message (text only), e.g. why a branch could not be deleted with -d. */
  detail?: string;
  /** The action is running: the bar stays up and its buttons wait. */
  busy?: boolean;
  onOk: () => void;
  onCancel: () => void;
}

const DETAIL_LIMIT = 600;

/** The slate confirm bar across the top (shared by delete stash, apply onto a dirty tree, partial staging and the phase 11 actions). Escape cancels. */
export function ConfirmBar({ message, okLabel, cancelLabel = 'Cancel', kind, detail, busy = false, onOk, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);
  return (
    <div className={`confirm-bar${detail ? ' has-detail' : ''}`} data-testid="confirm-bar" role="alertdialog" {...(kind ? { 'data-kind': kind } : {})}>
      <span className="confirm-text">
        <span data-testid="confirm-message">{message}</span>
        {detail && (
          <span className="confirm-detail" data-testid="confirm-detail">
            {detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}...` : detail}
          </span>
        )}
      </span>
      <button className="confirm-ok" data-testid="confirm-ok" disabled={busy} onClick={onOk}>
        {okLabel}
      </button>
      <button className="confirm-cancel" data-testid="confirm-cancel" disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  );
}
