import { useState } from 'react';

/*
 * V4: the commit message editor of screen 39 (summary with a counter, description, Update Message, Cancel Amend / Cancel Reword).
 * Strings: AmendOrRewordPreviousCommitMessageButtonLabel, CancelAmendPreviousCommitMessageButtonLabel,
 * CancelRewordPreviousCommitMessageButtonLabel, RewordCommitMessageHelperText.
 */

const SUMMARY_LIMIT = 72;

interface Props {
  /** The commit's whole message as it is now. */
  message: string;
  /** The commit is the HEAD tip (amend wording, and no helper text). */
  isHead: boolean;
  /** How many commits above it get rebuilt. */
  rebuilt: number;
  busy: boolean;
  onUpdate: (message: string) => void;
  onCancel: () => void;
}

export function RewordEditor({ message, isHead, rebuilt, busy, onUpdate, onCancel }: Props) {
  const nl = message.indexOf('\n');
  const first = nl < 0 ? message : message.slice(0, nl);
  const rest = nl < 0 ? '' : message.slice(nl + 1).replace(/^\s*\n/, '').replace(/\s+$/, '');
  const [summary, setSummary] = useState(first);
  const [description, setDescription] = useState(rest);
  const left = SUMMARY_LIMIT - summary.length;
  // Unchanged text is never sent back (it would turn "a\nb" into "a\n\nb").
  const ok = summary.trim() !== '' && !busy && (summary !== first || description !== rest);
  const save = () => onUpdate(description.trim() === '' ? summary : `${summary}\n\n${description}`);
  return (
    <div className="reword-editor" data-testid="reword-editor">
      <div className="commit-box">
        <div className="commit-summary-row">
          <input className="commit-summary" data-testid="reword-summary" autoFocus placeholder="Commit summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
          <span className={`commit-countdown${left < 0 ? ' negative' : ''}`} data-testid="reword-counter">
            {left}
          </span>
        </div>
        <textarea className="commit-description" data-testid="reword-description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {!isHead && rebuilt > 0 && (
        <div className="reword-helper" data-testid="reword-helper">
          Rewording this commit message will cause {rebuilt} commits to be rebased.
        </div>
      )}
      <div className="reword-buttons">
        <button className="reword-btn update" data-testid="reword-update" disabled={!ok} onClick={save}>
          Update Message
        </button>
        <button className="reword-btn cancel" data-testid="reword-cancel" disabled={busy} onClick={onCancel}>
          {isHead ? 'Cancel Amend' : 'Cancel Reword'}
        </button>
      </div>
    </div>
  );
}
