import { useEffect, useMemo, useRef, useState } from 'react';
import type { RebaseAction, RebasePlan, RebaseStep } from '@gitslappin/shared';
import { api } from '../api';
import { identiconUri } from '../lib/identicon';

/*
 * V4: the Interactive Rebase panel (it takes the place of the graph, docs-images interactive-rebase--*). Rows are newest first, as in the graph.
 * Keys with a row selected: P / S / R / D set the action (R asks for the new message), Ctrl+Up / Ctrl+Down move the row.
 * Strings: PendingInteractiveRebasePanel-InteractiveRebase / -RebasingXOnto / -Reset / -CancelRebase / -StartRebase / -UpdateMessage,
 * ContextMenu-PickCommit / -RewordCommit / -SquashCommit / -DropCommit, RewordInputTitle.
 */

interface Row {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  action: RebaseAction;
  message?: string;
}

const LABEL: Record<RebaseAction, string> = { pick: 'Pick commit', reword: 'Reword commit', squash: 'Squash commit', drop: 'Drop commit' };
const KEYS: Record<string, RebaseAction> = { p: 'pick', s: 'squash', r: 'reword', d: 'drop' };

const initial = (plan: RebasePlan): Row[] => plan.commits.map((c) => ({ ...c, action: 'pick' }));

/** The oldest row cannot be a squash, and neither can a row with only dropped commits below it: there is nothing to squash into. */
function normalise(rows: Row[]): Row[] {
  let seen = false; // a kept (not dropped) row below
  const out = [...rows];
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]!;
    if (r.action === 'squash' && !seen) out[i] = { ...r, action: 'pick' };
    else if (r.action !== 'drop') seen = true;
  }
  return out;
}

interface Props {
  repoId: string;
  plan: RebasePlan;
  busy: boolean;
  /** steps are OLDEST FIRST. */
  onStart: (steps: RebaseStep[]) => void;
  onCancel: () => void;
}

export function RebasePanel({ repoId, plan, busy, onStart, onCancel }: Props) {
  const [rows, setRows] = useState<Row[]>(() => initial(plan));
  const [selected, setSelected] = useState<string | null>(null);
  const [rewording, setRewording] = useState<{ sha: string; text: string } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selRef = useRef(selected);
  selRef.current = selected;
  const popRef = useRef(rewording);
  popRef.current = rewording;

  /** Keys and the select alike: a squash with nothing kept below it turns back into a pick. */
  const setAction = (sha: string, action: RebaseAction) => setRows((rs) => normalise(rs.map((r) => (r.sha === sha ? { ...r, action } : r))));
  const move = (sha: string, by: -1 | 1) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.sha === sha);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return normalise(next);
    });

  /** Reword asks for the message first; the row only becomes a reword when Update Message is pressed. */
  const startReword = (sha: string) => {
    const r = rowsRef.current.find((x) => x.sha === sha);
    if (!r) return;
    setRewording({ sha, text: r.message ?? r.subject });
    if (r.message === undefined) {
      // The popover opens with the subject at once and is filled with the whole message when it arrives.
      void api
        .commit(repoId, sha)
        .then((d) => setRewording((cur) => (cur && cur.sha === sha && cur.text === r.subject ? { sha, text: d.message.replace(/\s+$/, '') } : cur)))
        .catch(() => undefined);
    }
  };
  const choose = (sha: string, action: RebaseAction) => (action === 'reword' ? startReword(sha) : setAction(sha, action));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (popRef.current || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
      const sha = selRef.current;
      if (!sha) return;
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        move(sha, e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const action = KEYS[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      choose(sha, action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = useMemo<RebaseStep[]>(() => [...rows].reverse().map((r) => ({ sha: r.sha, action: r.action, ...(r.action === 'reword' && r.message !== undefined ? { message: r.message } : {}) })), [rows]);

  return (
    <div className="rebase-panel" data-testid="rebase-panel">
      <div className="rebase-header">
        <span className="rebase-pill" data-testid="rebase-title">
          Interactive Rebase
        </span>
        <span className="rebase-pill onto" data-testid="rebase-onto">
          Rebasing {plan.branch} onto {plan.ontoLabel}
        </span>
      </div>
      <div className="rebase-rows">
        {rows.map((r, idx) => (
          <div
            key={r.sha}
            className={`rebase-row action-${r.action}${selected === r.sha ? ' selected' : ''}`}
            data-testid="rebase-row"
            data-sha={r.sha}
            data-action={r.action}
            data-selected={selected === r.sha ? 'true' : 'false'}
            onClick={() => setSelected(r.sha)}
          >
            <select className="rebase-action" data-testid="rebase-action" value={r.action} onChange={(e) => choose(r.sha, e.target.value as RebaseAction)} onClick={(e) => e.stopPropagation()}>
              {(Object.keys(LABEL) as RebaseAction[]).map((a) => (
                <option key={a} value={a} disabled={a === 'squash' && !rows.slice(idx + 1).some((x) => x.action !== 'drop')}>
                  {LABEL[a]}
                </option>
              ))}
            </select>
            <img className="rebase-avatar" src={identiconUri(r.authorEmail)} alt="" width={22} height={22} title={r.authorName} />
            <span className="rebase-message" data-testid="rebase-message">
              {r.message !== undefined && r.action === 'reword' ? (r.message.split('\n')[0] ?? '') : r.subject}
            </span>
          </div>
        ))}
      </div>
      <div className="rebase-buttons">
        <button className="rebase-btn reset" data-testid="rebase-reset" disabled={busy} onClick={() => setRows(initial(plan))}>
          Reset
        </button>
        <button className="rebase-btn cancel" data-testid="rebase-cancel" disabled={busy} onClick={onCancel}>
          Cancel Rebase
        </button>
        <button className="rebase-btn start" data-testid="rebase-start" disabled={busy} onClick={() => onStart(steps)}>
          Start Rebase
        </button>
      </div>
      {rewording && (
        <div className="rebase-reword-popover" data-testid="rebase-reword-popover" role="dialog">
          <div className="rebase-reword-title" data-testid="rebase-reword-title">
            Reword commit message
          </div>
          <textarea
            className="rebase-reword-input"
            data-testid="rebase-reword-input"
            autoFocus
            value={rewording.text}
            onChange={(e) => setRewording({ sha: rewording.sha, text: e.target.value })}
          />
          <div className="reword-buttons">
            <button className="reword-btn update" data-testid="rebase-reword-update" disabled={rewording.text.trim() === ''} onClick={() => {
              const { sha, text } = rewording;
              setRows((rs) => normalise(rs.map((r) => (r.sha === sha ? { ...r, action: 'reword', message: text } : r))));
              setRewording(null);
            }}>
              Update Message
            </button>
            <button className="reword-btn cancel" data-testid="rebase-reword-cancel" onClick={() => setRewording(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
