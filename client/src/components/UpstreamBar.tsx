import { useState } from 'react';
import { branchNameProblem } from '@gitslappin/shared';

interface Props {
  /** The local branch that gets the upstream. */
  branch: string;
  remotes: string[];
  onSubmit: (remote: string, remoteBranch: string) => void;
  onCancel: () => void;
}

/** Slate confirm bar: asks which remote branch a local branch pushes to and pulls from. */
export function UpstreamBar({ branch, remotes, onSubmit, onCancel }: Props) {
  const [remote, setRemote] = useState(remotes.includes('origin') ? 'origin' : (remotes[0] ?? ''));
  const [name, setName] = useState(branch);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (branchNameProblem(name) !== null || name.includes('+')) setError('The given branch name is not valid'); // SetUpstreamPrompt-InvalidBranchName
    else onSubmit(remote, name);
  };
  return (
    <div className="confirm-bar upstream-bar" data-testid="upstream-bar" role="alertdialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <span data-testid="upstream-message">{`What remote/branch should "${branch}" push to and pull from?`}</span>
      {/* SetUpstreamPrompt-SelectRemoteBranchMessage */}
      <select className="upstream-select" data-testid="upstream-remote" value={remote} onChange={(e) => setRemote(e.target.value)}>
        {remotes.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        className="upstream-input"
        data-testid="upstream-branch"
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && (
        <span className="upstream-error" data-testid="upstream-error" role="alert">
          {error}
        </span>
      )}
      <button className="confirm-cancel" data-testid="upstream-submit" onClick={submit}>
        Submit
      </button>
      <button className="confirm-cancel" data-testid="upstream-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
