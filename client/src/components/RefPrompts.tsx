import { useState } from 'react';
import { branchNameProblem } from '@gitslappin/shared';

/** PromptForNewBranchName-InvalidBranchName / PromptForCreateTagName-InvalidTagName */
const INVALID_BRANCH = 'The given branch name is not valid';
const INVALID_TAG = 'The given tag name is not valid';

/** Rename a local branch (PromptForNewBranchName-*). Enter submits, Escape cancels. No confirm bar: the name is the question. */
export function RenamePrompt({ name, onSubmit, onCancel }: { name: string; onSubmit: (newName: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (branchNameProblem(value) !== null || value.includes('+')) setError(INVALID_BRANCH);
    else onSubmit(value);
  };
  return (
    <div className="branch-prompt" data-testid="rename-prompt" role="dialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="branch-prompt-message" data-testid="rename-message">
        {`Rename '${name}' to:`}
      </div>
      <input
        className="branch-prompt-input"
        data-testid="rename-input"
        placeholder="new branch name" // PromptForNewBranchName-Placeholder
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && (
        <div className="branch-prompt-error" data-testid="rename-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Create a tag on a commit. A plain tag submits with Enter; an annotated one adds a message box and a button. Escape cancels. */
export function TagPrompt({ annotated, onSubmit, onCancel }: { annotated: boolean; onSubmit: (name: string, message?: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (value === '' || branchNameProblem(value) !== null) setError(INVALID_TAG);
    else onSubmit(value, annotated ? message : undefined);
  };
  return (
    <div className="branch-prompt" data-testid="tag-prompt" role="dialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <input
        className="branch-prompt-input"
        data-testid="tag-input"
        placeholder="enter tag name" // RefZone-EnterTagName
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && (
        <div className="branch-prompt-error" data-testid="tag-input-error" role="alert">
          {error}
        </div>
      )}
      {annotated && (
        <>
          <div className="branch-prompt-label" data-testid="tag-annotation-label">
            Message:
          </div>
          <textarea
            className="branch-prompt-textarea"
            data-testid="tag-annotation"
            placeholder="Annotation message" // PromptForTagAnnotation-Placeholder
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="branch-prompt-actions">
            <button className="btn-outline" data-testid="tag-submit" onClick={submit}>
              Create Annotated Tag
            </button>
          </div>
        </>
      )}
    </div>
  );
}
