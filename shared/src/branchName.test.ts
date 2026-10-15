import { describe, expect, it } from 'vitest';
import { branchNameProblem } from './branchName';

/*
 * Contract (shared/src/branchName.ts):
 *   export type BranchNameProblem = 'empty' | 'spaces' | 'invalid';
 *   export function branchNameProblem(name: string): BranchNameProblem | null;
 * 'empty'   -> Error-BranchNameEmpty ("Must fill in branch name")
 * 'spaces'  -> Error-BranchNameMayNotContainSpaces ("Spaces are not allowed in branch name")
 * 'invalid' -> PromptForNewBranchName-InvalidBranchName ("The given branch name is not valid")
 * null      -> no problem found by the pure checks.
 */
describe('branchNameProblem', () => {
  it('reports an empty name', () => {
    expect(branchNameProblem('')).toBe('empty');
  });

  it('reports spaces inside a name', () => {
    expect(branchNameProblem('my branch')).toBe('spaces');
    expect(branchNameProblem('feature/new thing')).toBe('spaces');
  });

  it.each([
    ['leading dash', '-x'],
    ['leading dash option-like', '--orphan'],
    ['reflog expression', 'a@{1}'],
    ['bare @', '@'],
    ['double dot', 'a..b'],
    ['.lock suffix', 'topic.lock'],
    ['trailing slash', 'a/'],
    ['leading slash', '/a'],
    ['double slash', 'a//b'],
    ['leading dot component', '.hidden'],
    ['component starting with dot', 'a/.b'],
    ['trailing dot', 'a.'],
    ['tilde', 'a~b'],
    ['caret', 'a^b'],
    ['colon', 'a:b'],
    ['question mark', 'a?b'],
    ['asterisk', 'a*b'],
    ['open bracket', 'a[b'],
    ['backslash', 'a\\b'],
    ['control character', 'a\u0001b'],
    ['256 characters', 'a'.repeat(256)],
  ])('rejects %s', (_label, name) => {
    expect(branchNameProblem(name)).toBe('invalid');
  });

  it.each(['main', 'feature/login', 'fix-1', 'v1.0', 'a_b', 'team/a/feat/x', 'a'.repeat(255)])('accepts %s', (name) => {
    expect(branchNameProblem(name)).toBeNull();
  });
});
