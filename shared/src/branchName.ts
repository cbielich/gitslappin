export type BranchNameProblem = 'empty' | 'spaces' | 'invalid';

const MAX_LENGTH = 255;

/**
 * The pure checks for a new branch name (the server also runs `check-ref-format --branch`).
 * 'empty' -> Error-BranchNameEmpty, 'spaces' -> Error-BranchNameMayNotContainSpaces,
 * 'invalid' -> PromptForNewBranchName-InvalidBranchName. null = no problem found.
 */
export function branchNameProblem(name: string): BranchNameProblem | null {
  if (name === '') return 'empty';
  if (name.includes(' ')) return 'spaces';
  if (name.length > MAX_LENGTH || name === '@' || name.startsWith('-') || name.includes('@{') || name.includes('..')) return 'invalid';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return 'invalid';
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('//')) return 'invalid';
  for (const part of name.split('/')) {
    if (part.startsWith('.') || part.endsWith('.lock')) return 'invalid';
  }
  return null;
}
