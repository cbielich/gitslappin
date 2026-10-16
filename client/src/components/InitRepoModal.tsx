import { useCallback, useEffect, useState } from 'react';
import { branchNameProblem, folderNameProblem, type RepoInfo, type TemplateList } from '@gitslappin/shared';
import { api, ApiRequestError } from '../api';
import { joinForDisplay } from './CloneRepoModal';
import { FolderBrowser } from './FolderBrowser';
import { RepoModalFrame, RmRow } from './RepoModalFrame';
import { SearchSelect } from './SearchSelect';

export function InitRepoModal({ onClose, onOpened }: { onClose: () => void; onOpened: (repo: RepoInfo) => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [branch, setBranch] = useState('');
  const [gitignore, setGitignore] = useState('');
  const [license, setLicense] = useState('');
  const [templates, setTemplates] = useState<TemplateList>({ gitignore: [], license: [] });
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<{ text: string; detail: string } | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => undefined);
  }, []);

  const nameProblem = folderNameProblem(name);
  const showNameError = nameProblem !== null && (name !== '' || submitted);
  const branchBad = branch !== '' && (branch.includes('+') || branchNameProblem(branch) !== null);
  const closeBrowser = useCallback(() => setBrowsing(false), []);
  const picked = async (p: string) => {
    setParent(p);
    setBrowsing(false);
  };

  async function submit() {
    setSubmitted(true);
    if (nameProblem || branchBad) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(
        await api.initRepo({
          parent,
          name,
          ...(branch !== '' ? { defaultBranch: branch } : {}),
          ...(gitignore !== '' ? { gitignore } : {}),
          ...(license !== '' ? { license } : {}),
        }),
      );
    } catch (e) {
      const path = e instanceof ApiRequestError && typeof e.body?.path === 'string' ? e.body.path : '';
      setError({
        text: path ? `The folder was created in ${path}, but the first commit failed. ${e instanceof Error ? e.message : ''}` : e instanceof Error ? e.message : String(e),
        detail: e instanceof ApiRequestError ? (e.detail ?? '') : '',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RepoModalFrame prefix="init" title="Initialize a Repository" navLabel="Local Only" heading="Initialize a Repo" onClose={onClose}>
        <RmRow label="Name">
          <input className="rm-input" data-testid="init-name-input" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} autoFocus />
          {showNameError && (
            <div className="rm-field-error" data-testid="init-name-error">
              {nameProblem}
            </div>
          )}
        </RmRow>
        <RmRow label="Initialize in">
          <div className="rm-inline">
            <input className="rm-input" data-testid="init-parent-input" value={parent} disabled={busy} onChange={(e) => setParent(e.target.value)} />
            <button type="button" className="rm-btn rm-btn-blue" data-testid="init-browse" disabled={busy} onClick={() => setBrowsing(true)}>
              Browse
            </button>
          </div>
        </RmRow>
        <RmRow label="Full path" testId="init-fullpath">
          <span className="rm-fullpath">{joinForDisplay(parent, name)}</span>
        </RmRow>
        <RmRow label="Default branch name">
          <input className="rm-input" data-testid="init-branch-input" placeholder="main" value={branch} disabled={busy} onChange={(e) => setBranch(e.target.value)} />
          {branchBad && (
            <div className="rm-field-error" data-testid="init-branch-error">
              Invalid branch name.
            </div>
          )}
        </RmRow>
        <RmRow label=".gitignore Template (optional)">
          <SearchSelect prefix="init-gitignore" value={gitignore} options={templates.gitignore.map((id) => ({ id, label: id }))} placeholder="Select..." onChange={setGitignore} disabled={busy} />
        </RmRow>
        <RmRow label="License (optional)">
          <SearchSelect prefix="init-license" value={license} options={templates.license.map((l) => ({ id: l.id, label: l.title }))} placeholder="Select..." onChange={setLicense} disabled={busy} />
        </RmRow>
        {error && (
          <div className="rm-error" data-testid="init-error" role="alert">
            <div className="rm-error-detail">
              {error.text}
              {error.detail && error.detail !== error.text ? `\n${error.detail}` : ''}
            </div>
          </div>
        )}
        <div className="rm-actions">
          <button type="button" className="rm-btn rm-btn-green" data-testid="init-submit" disabled={busy} onClick={() => void submit()}>
            Create Repository
          </button>
        </div>
      </RepoModalFrame>
      {browsing && <FolderBrowser mode="pick" start={parent} onClose={closeBrowser} onOpen={picked} />}
    </>
  );
}
