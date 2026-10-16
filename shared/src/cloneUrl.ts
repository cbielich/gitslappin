const MAX_URL = 2048;
const SCHEMES = ['https', 'http', 'ssh', 'git', 'file'];
const SCP_STYLE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

/**
 * The checks every clone URL must pass before git sees it (the server runs the same function). null = acceptable,
 * otherwise the message to show. Allowed: https, http, ssh, git, file:///<absolute local path>, and scp-style user@host:path.
 */
export function cloneUrlProblem(input: string): string | null {
  const url = String(input).trim();
  if (url === '') return 'Enter the URL of the repository to clone.';
  if (url.length > MAX_URL) return `The URL is longer than ${MAX_URL} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return 'The URL must not contain spaces or control characters.';
  if (url.startsWith('-')) return 'The URL must not start with "-".';
  if (url.includes('::')) return 'URLs with "::" (git remote helpers such as ext:: and fd::) are not allowed.';
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (!SCHEMES.includes(name)) return `The URL scheme "${name}" is not allowed. Use https, http, ssh, git or file.`;
    if (name === 'file') {
      const rest = url.slice(scheme[0].length);
      if (!rest.startsWith('/') || rest.startsWith('//')) return 'A file:// URL must point to a local absolute path, like file:///C:/folder/repo.git.';
    }
    return null;
  }
  if (SCP_STYLE.test(url)) return null;
  return 'Enter a URL such as https://host/owner/repo.git or git@host:owner/repo.git. Plain local paths are not accepted.';
}

/** Last path segment of a clone URL, with one trailing ".git" and any trailing "/" stripped. '' when there is none. */
export function repoNameFromUrl(input: string): string {
  const url = String(input).trim().replace(/\/+$/, '');
  const last = url.split(/[/:]/).pop() ?? '';
  return last.endsWith('.git') ? last.slice(0, -4) : last;
}
