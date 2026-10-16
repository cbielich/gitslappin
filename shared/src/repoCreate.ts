import type { RepoInfo } from './index';

/** Body of POST /api/repos/clone. The folder name is repoNameFromUrl(url). */
export interface CloneRequest {
  parent: string;
  url: string;
  shallow?: { branch?: string; by: 'depth' | 'since'; depth?: number; since?: string; flags?: string };
  sparse?: { paths: string[]; blobless: boolean };
}

/** One NDJSON line of the clone stream: progress lines, then exactly one of done / error / cancelled. */
export type CloneStreamLine =
  | { type: 'progress'; phase: string; percent: number }
  | { type: 'done'; repo: RepoInfo }
  | { type: 'error'; error: string; stderr: string }
  | { type: 'cancelled'; path: string };

/** Body of POST /api/repos/init. */
export interface InitRequest {
  parent: string;
  name: string;
  defaultBranch?: string;
  gitignore?: string;
  license?: string;
}

/** Body of GET /api/repos/templates. */
export interface TemplateList {
  gitignore: string[];
  license: { id: string; title: string }[];
}
