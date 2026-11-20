import type { FileOpenHow, FileStatus } from '@gitslappin/shared';
import type { MenuEntry } from './refMenu';

/*
 * The right-click menu of a file in a COMMIT's details panel (GitKraken 12.6 order and wording). Pure: the view supplies what each item does.
 * Groups, in order: history | OS launch (desktop only) | copy path | edit, delete | restore. An empty group loses its divider.
 */

export interface FileMenuActions {
  history: (path: string, blame: boolean) => void;
  difftool: (file: { path: string; oldPath?: string }) => void;
  open: (path: string, how: FileOpenHow) => void;
  copyPath: (path: string) => void;
  edit: (path: string) => void;
  remove: (path: string) => void;
  restore: (path: string) => void;
}

export interface FileMenuFile {
  path: string;
  oldPath?: string;
  /** null = the commit did not change the file ("View all files"). */
  status: FileStatus | null;
}

/** The file's path in the working folder, in the repo's own notation (backslashes when the root uses them). */
export function absoluteFilePath(root: string, path: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`;
}

export function fileMenuEntries(file: FileMenuFile, desktop: boolean, a: FileMenuActions): MenuEntry[] {
  const { path } = file;
  const deleted = file.status === 'D';
  const item = (id: string, label: string, run: () => void): MenuEntry => ({ type: 'item', id, label, run });
  const groups: MenuEntry[][] = [
    deleted ? [] : [item('file-history', 'File History', () => a.history(path, false)), item('file-blame', 'File Blame', () => a.history(path, true))],
    desktop
      ? [
          ...(file.status === null ? [] : [item('file-difftool', 'Open in external diff tool', () => a.difftool({ path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) }))]),
          item('file-editor', 'Open in external editor', () => a.open(path, 'editor')),
          item('file-default', 'Open file in default program', () => a.open(path, 'default')),
          item('file-show', 'Show in folder', () => a.open(path, 'show')),
        ]
      : [],
    [item('file-copy-path', 'Copy file path', () => a.copyPath(path))],
    [item('file-edit', 'Edit file', () => a.edit(path)), item('file-delete', 'Delete file', () => a.remove(path))],
    deleted ? [] : [item('file-restore', 'Restore file from this commit', () => a.restore(path))],
  ];
  const out: MenuEntry[] = [];
  for (const g of groups.filter((x) => x.length > 0)) {
    if (out.length > 0) out.push({ type: 'divider' });
    out.push(...g);
  }
  return out;
}
