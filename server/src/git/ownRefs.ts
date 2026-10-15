/**
 * The refs this app writes in a user's repo (safety snapshots `undo/<sha>` and `stash-keep/<sha>`). New writes go to
 * `refs/gitslappin/*`. Repos used before the rename (GitGit) still hold refs under `refs/gitgit/*`: those are the user's
 * safety snapshots, so they are never renamed or deleted, and every walk over all refs must hide BOTH namespaces.
 */
export const OWN_REF_PREFIXES = ['refs/gitslappin/', 'refs/gitgit/'] as const;

/** `git log` arguments that hide both namespaces. They must come before `--all`. */
export const OWN_REF_EXCLUDES: string[] = OWN_REF_PREFIXES.map((p) => `--exclude=${p}*`);

/** True for a ref name (or a `<refname> <sha>` line) in either namespace. */
export const isOwnRef = (line: string): boolean => OWN_REF_PREFIXES.some((p) => line.startsWith(p));
