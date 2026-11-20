/** Payloads of the commit file menu and in-app editor routes (GET file-edit, POST file-edit/save, file/restore, file/delete, file/open, file/difftool). */

/** GET /api/repos/:id/file-edit. `text` has no BOM; `hash` is the sha256 hex of the working bytes (BOM included). */
export interface FileEditInfo {
  text: string;
  hash: string;
  bom: boolean;
  eol: 'lf' | 'crlf';
}

/** Answer of file-edit/save, file/restore and file/delete. */
export interface FileActionResult {
  /** Blob holding the working bytes from before the change ('' when the path did not exist in the working tree). */
  backup: string;
  /** The change was recorded in the undo journal. false: the backup sha is the only way back. */
  undoable: boolean;
  /** file/restore only: false when nothing changed (the file already matched), so there was nothing to undo and no backup was needed. Absent otherwise. */
  changed?: false;
  /** file/restore only: the index tree as it was before (pinned). */
  indexBackup?: string;
  /** file/delete only: where the file was moved to (inside the git folder). */
  trashPath?: string;
}

export type FileOpenHow = 'editor' | 'default' | 'show';
