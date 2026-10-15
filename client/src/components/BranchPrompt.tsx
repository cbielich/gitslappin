import { useState } from 'react';
import { branchNameProblem } from '@gitslappin/shared';
import { BRANCH_NAME_ERRORS } from './graph/BranchInput';

interface Props {
  /** The local branch that already exists. */
  exists: string;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/** Shown when checking out a remote branch whose local namesake sits on another commit. "Reset Local to Here" waits for phase 11. */
export function BranchPrompt({ exists, onCreate, onCancel }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const problem = branchNameProblem(value);
    if (problem) setError(BRANCH_NAME_ERRORS[problem]);
    else onCreate(value);
  };
  return (
    <div className="branch-prompt" data-testid="branch-prompt" role="dialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="branch-prompt-message" data-testid="branch-prompt-message">
        {`A local '${exists}' already exists.`}
      </div>
      <input
        className="branch-prompt-input"
        data-testid="branch-prompt-input"
        placeholder="branch name" // PromptNewBranchAtRemote-BranchNamePlaceholder
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && (
        <div className="branch-prompt-error" data-testid="branch-prompt-error">
          {error}
        </div>
      )}
      <div className="branch-prompt-actions">
        <button className="btn-outline" data-testid="branch-prompt-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-outline" data-testid="branch-prompt-create" onClick={submit}>
          Create Branch Here
        </button>
      </div>
    </div>
  );
}
