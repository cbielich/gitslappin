const MAX_URL = 2048;
const SCHEMES = ['https', 'http', 'ssh', 'git', 'file'];
const SCP_STYLE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$|^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+:[^\s:]+$/;
const LOCAL_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/;

/**
 * The pure checks every remote URL (pull and push) must pass before git sees it. null = nothing found, otherwise the message to show.
 * Differs from cloneUrlProblem in one place: an absolute local path (C:\x, /srv/x) is allowed here.
 */
export function remoteUrlProblem(input: string): string | null {
  if (typeof input !== 'string') return 'Enter a URL.';
  const url = input;
  if (url.trim() === '') return 'Enter a URL.';
  if (url.length > MAX_URL) return `The URL is longer than ${MAX_URL} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) return 'The URL must not contain control characters.';
  if (url.startsWith('-')) return 'The URL must not start with "-".';
  if (url.includes('::')) return 'URLs with "::" (git remote helpers such as ext:: and fd::) are not allowed.';
  if (/^[\\/]{2}/.test(url)) return 'UNC and device paths are not supported.';
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
  if (/^[A-Za-z][A-Za-z0-9+.-]*:[^/\\\s]/.test(url) && !SCP_STYLE.test(url) && !/^[A-Za-z]:[\\/]/.test(url)) {
    return 'That URL is not supported. Use https, http, ssh, git or file, or user@host:path.';
  }
  if (LOCAL_ABSOLUTE.test(url)) return null;
  if (SCP_STYLE.test(url)) return null;
  return 'Enter a URL such as https://host/owner/repo.git, git@host:owner/repo.git or an absolute folder path.';
}

/** True for `file:///...` and absolute local paths: the forms the server checks against the roots. */
export function isLocalRemoteUrl(url: string): boolean {
  return /^file:\/\/\//i.test(url) || LOCAL_ABSOLUTE.test(url);
}
