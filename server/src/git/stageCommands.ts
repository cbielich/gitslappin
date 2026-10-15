/*
 * Fixed argv builders for everything that changes the index or HEAD. Each one hard-codes `--cached` /
 * `--staged`; there is deliberately no builder for a plain `restore`, `rm` or `apply`, so nothing here can touch
 * working-tree files. `add -A` is only built for an explicit Stage All Changes request.
 */

/** Pathspecs arrive NUL-separated on stdin, and always literally (no globs, no magic). */
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

export const MAX_PATHS = 10_000;

export function stagePathsArgs(): string[] {
  return ['--literal-pathspecs', 'add', ...FROM_STDIN];
}

export function stageAllArgs(): string[] {
  return ['add', '-A'];
}

/** `restore --staged` normally; on an unborn HEAD there is nothing to restore from, so `rm --cached`. */
export function unstagePathsArgs(unborn: boolean): string[] {
  return unborn
    ? ['--literal-pathspecs', 'rm', '--cached', '-f', '-r', '-q', ...FROM_STDIN]
    : ['--literal-pathspecs', 'restore', '--staged', ...FROM_STDIN];
}

/** `apply --cached` (index only). `reverse` unstages. `check` only tests that the patch applies. */
export function applyCachedArgs(reverse: boolean, check: boolean): string[] {
  return ['apply', '--cached', ...(reverse ? ['-R'] : []), '--whitespace=nowarn', ...(check ? ['--check'] : []), '-'];
}

/**
 * `merge` is for the merge commit: the "#" lines git put in MERGE_MSG must not land in the message, and the commit is
 * allowed to have no change against HEAD (every conflict was resolved to HEAD's content).
 */
export function commitArgs(amend: boolean, merge = false, strip = merge): string[] {
  return ['commit', ...(amend ? ['--amend'] : []), ...(merge ? ['--allow-empty'] : []), '-F', '-', ...(strip ? ['--cleanup=strip'] : [])];
}

/** The diff the stage-lines route re-reads: raw bytes, paths octal-escaped, never a whitespace flag. */
export function reDiffArgs(source: 'unstaged' | 'staged' | 'untracked', paths: string[]): string[] {
  // Pinned so diff.noprefix / diff.context / diff.mnemonicPrefix / diff.algorithm in the user's config cannot change paths or hunks.
  const common = [
    '-c', 'core.quotepath=on', '--literal-pathspecs', 'diff', '-p', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--inter-hunk-context=0', '--diff-algorithm=default',
  ];
  if (source === 'untracked') return [...common, '--no-index', '--', '/dev/null', ...paths];
  return [...common, ...(source === 'staged' ? ['--cached', '-M'] : []), '--', ...paths];
}
