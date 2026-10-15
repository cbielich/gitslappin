import { useState } from 'react';
import { branchNameProblem } from '@gitslappin/shared';

/** Error-BranchNameEmpty, Error-BranchNameMayNotContainSpaces, PromptForNewBranchName-InvalidBranchName */
export const BRANCH_NAME_ERRORS = {
  empty: 'Must fill in branch name',
  spaces: 'Spaces are not allowed in branch name',
  invalid: 'The given branch name is not valid',
} as const;

/** Inline input in a row's BRANCH / TAG cell. Enter submits, Esc or blur cancels, and spaces are never replaced. */
export function BranchInput({ value, onChange, onSubmit, onCancel }: { value: string; onChange: (v: string) => void; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input
        className="branch-input"
        data-testid="branch-input"
        placeholder="enter branch name" // RefZone-EnterBranchName
        autoFocus
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setError(null);
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter') {
            const problem = branchNameProblem(value);
            if (problem) setError(BRANCH_NAME_ERRORS[problem]);
            else onSubmit(value);
          }
        }}
      />
      {error && (
        <div className="branch-input-error" data-testid="branch-input-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
