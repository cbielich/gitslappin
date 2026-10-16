const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** null when `name` is one legal folder name (Windows rules, so it is legal everywhere), otherwise the message. Used by clone, create and the Create form. */
export function folderNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return 'Enter a name.';
  if (name.length > 255) return 'The name is longer than 255 characters.';
  if (name === '.' || name === '..') return 'The name must not be "." or "..".';
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name)) return 'The name must be one folder name: no \ / : * ? " < > | or control characters.';
  if (/[. ]$/.test(name)) return 'The name must not end with a dot or a space.';
  if (RESERVED.test(name)) return `"${name}" is a reserved name on Windows.`;
  if (name.toLowerCase() === '.git') return 'The name must not be ".git".';
  return null;
}
