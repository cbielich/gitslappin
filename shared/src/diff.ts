export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'C';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  /** The line without its `+`/`-`/space prefix. Kept exactly (a CR from CRLF stays). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** The line is the last one of its side and has no newline at the end of the file. */
  noEol?: boolean;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ section` line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: DiffStatus;
  binary: boolean;
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  /** The raw lines before the first hunk. */
  headerLines: string[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Over the line limit: only the stats are filled in, `hunks` is empty. */
  tooLarge: boolean;
  /** The path is unmerged (a merge conflict); no diff is produced. */
  conflicted?: boolean;
}

/** Full text of both sides of a file diff (for Inline, Split and File View). */
export interface DiffContents {
  old: string;
  new: string;
}

export type DiffSource = 'commit' | 'unstaged' | 'staged' | 'stash' | 'workdir';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/** Decodes a git C-quoted string (starting at the opening quote). Returns the text and the index after the closing quote. */
function unquoteC(s: string, start: number): { text: string; end: number } {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  let i = start + 1;
  while (i < s.length && s[i] !== '"') {
    const ch = s[i]!;
    if (ch !== '\\') {
      const cp = s.codePointAt(i)!;
      const str = String.fromCodePoint(cp);
      bytes.push(...enc.encode(str));
      i += str.length;
      continue;
    }
    const n = s[i + 1] ?? '';
    if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
      bytes.push(parseInt(m, 8) & 0xff);
      i += 1 + m.length;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
    bytes.push(map[n] ?? n.charCodeAt(0));
    i += 2;
  }
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
}

const stripPrefix = (p: string): string => (/^[ab]\//.test(p) ? p.slice(2) : p);

/** Reads the path out of a `rename from` / `--- a/x` style value (quoted or not). */
function pathValue(v: string): string {
  return v.startsWith('"') ? unquoteC(v, 0).text : v;
}

/** Paths from `diff --git a/X b/Y`. */
function parseGitHeader(rest: string): { a: string; b: string } {
  if (rest.startsWith('"')) {
    const first = unquoteC(rest, 0);
    const tail = rest.slice(first.end).trimStart();
    return { a: stripPrefix(first.text), b: stripPrefix(pathValue(tail)) };
  }
  const q = rest.indexOf(' "');
  if (q > 0 && rest.endsWith('"')) return { a: stripPrefix(rest.slice(0, q)), b: stripPrefix(pathValue(rest.slice(q + 1))) };
  if (rest.startsWith('a/')) {
    const body = rest.slice(2);
    // Same path on both sides: `X b/X`.
    const len = (body.length - 3) / 2;
    if (Number.isInteger(len) && len > 0 && body.slice(len, len + 3) === ' b/' && body.slice(0, len) === body.slice(len + 3)) {
      return { a: body.slice(0, len), b: body.slice(0, len) };
    }
  }
  const i = rest.indexOf(' b/');
  if (i > 0) return { a: stripPrefix(rest.slice(0, i)), b: stripPrefix(rest.slice(i + 1)) };
  return { a: rest, b: rest };
}

/** Parses `git diff -p` output (one or more files). Pure; never throws on odd input. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!text) return files;
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();

  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldSeen = 0;
  let newSeen = 0;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let plusPath: string | undefined;
  let minusPath: string | undefined;

  const finish = () => {
    if (!file) return;
    if (renameFrom !== undefined && renameTo !== undefined) {
      file.oldPath = renameFrom;
      file.path = renameTo;
    } else if (file.status === 'D' && minusPath) {
      file.path = minusPath;
    } else if (plusPath) {
      file.path = plusPath;
    }
    files.push(file);
  };

  for (const row of rows) {
    if (row.startsWith('diff --git ')) {
      finish();
      const { b } = parseGitHeader(row.slice('diff --git '.length));
      file = { path: b, status: 'M', binary: false, headerLines: [row], hunks: [], additions: 0, deletions: 0, tooLarge: false };
      hunk = null;
      renameFrom = renameTo = plusPath = minusPath = undefined;
      continue;
    }
    if (!file) continue;

    const inHunkBody = hunk !== null && (oldSeen < hunk.oldLines || newSeen < hunk.newLines || row.startsWith('\\'));
    if (hunk && inHunkBody) {
      if (row.startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noEol = true;
        continue;
      }
      const c = row[0];
      const body = row.slice(1);
      if (c === '+') {
        hunk.lines.push({ kind: 'add', text: body, oldNo: null, newNo: newNo++ });
        newSeen++;
        file.additions++;
      } else if (c === '-') {
        hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++, newNo: null });
        oldSeen++;
        file.deletions++;
      } else {
        hunk.lines.push({ kind: 'context', text: c === ' ' ? body : row, oldNo: oldNo++, newNo: newNo++ });
        oldSeen++;
        newSeen++;
      }
      continue;
    }

    const m = HUNK_RE.exec(row);
    if (m) {
      const oldStart = Number(m[1]);
      const newStart = Number(m[3]);
      hunk = {
        header: row,
        oldStart,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        ...(m[5] !== undefined ? { section: m[5] } : {}),
      };
      file.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (hunk) {
      // A "\ No newline" marker can trail a finished hunk.
      if (row.startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noEol = true;
      }
      continue;
    }

    file.headerLines.push(row);
    let v: RegExpExecArray | null;
    if ((v = /^similarity index (\d+)%/.exec(row))) file.similarity = Number(v[1]);
    else if (row.startsWith('rename from ')) {
      renameFrom = pathValue(row.slice('rename from '.length));
      file.status = 'R';
    } else if (row.startsWith('rename to ')) renameTo = pathValue(row.slice('rename to '.length));
    else if (row.startsWith('copy from ')) {
      renameFrom = pathValue(row.slice('copy from '.length));
      file.status = 'C';
    } else if (row.startsWith('copy to ')) renameTo = pathValue(row.slice('copy to '.length));
    else if (row.startsWith('new file mode')) file.status = 'A';
    else if (row.startsWith('deleted file mode')) file.status = 'D';
    else if (row.startsWith('old mode ')) file.oldMode = row.slice('old mode '.length).trim();
    else if (row.startsWith('new mode ')) file.newMode = row.slice('new mode '.length).trim();
    else if (row.startsWith('--- ')) {
      const p = pathValue(row.slice(4).replace(/\t.*$/, ''));
      if (p !== '/dev/null') minusPath = stripPrefix(p);
    } else if (row.startsWith('+++ ')) {
      const p = pathValue(row.slice(4).replace(/\t.*$/, ''));
      if (p !== '/dev/null') plusPath = stripPrefix(p);
    } else if (row.startsWith('Binary files ') || row.startsWith('GIT binary patch')) file.binary = true;
  }
  finish();
  return files;
}
