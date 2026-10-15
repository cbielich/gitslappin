import type { FileDiff } from './diff';

const NOEOL = '\\ No newline at end of file';

/** Git's C-quoting for a path inside a patch header: only quoted when it has a byte git would escape. */
function cQuote(prefix: 'a/' | 'b/', path: string): string {
  const bytes = new TextEncoder().encode(path);
  let needs = false;
  let out = '';
  const named: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
  for (const b of bytes) {
    const n = named[b];
    if (n !== undefined) {
      needs = true;
      out += n;
    } else if (b < 0x20 || b >= 0x7f) {
      needs = true;
      out += `\\${b.toString(8).padStart(3, '0')}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return needs ? `"${prefix}${out}"` : `${prefix}${path}`;
}

interface Entry {
  sign: ' ' | '-' | '+';
  text: string;
  noEol: boolean;
}

const modeOf = (file: FileDiff, kind: 'new' | 'deleted'): string => {
  const re = new RegExp(`^${kind} file mode (\\d+)`);
  for (const row of file.headerLines) {
    const m = re.exec(row);
    if (m) return m[1] as string;
  }
  return '100644';
};

/**
 * Builds a patch for one hunk of `file`, or for the chosen lines of it (`selected` = indexes into the hunk's lines;
 * undefined = the whole hunk). The patch is applied to the index: forward (stage) with `apply --cached`, reverse
 * (unstage) with `apply --cached -R`.
 *
 * The base side is the side the patch is applied to: the old side going forward, the new side in reverse.
 * Unselected lines that exist on the base side become context; the others are dropped. Counts are recomputed.
 * Line text is used exactly as given (CR stays). The header is written here, never copied, with the new path on both
 * sides (so a rename carries no rename lines).
 */
export function buildPatch(file: FileDiff, hunkIdx: number, selected: ReadonlySet<number> | undefined, reverse: boolean): string {
  const hunk = file.hunks[hunkIdx];
  if (!hunk) throw new Error('Hunk out of range.');

  const entries: Entry[] = [];
  hunk.lines.forEach((l, i) => {
    const noEol = l.noEol === true;
    if (l.kind === 'context') {
      entries.push({ sign: ' ', text: l.text, noEol });
      return;
    }
    if (selected === undefined || selected.has(i)) {
      entries.push({ sign: l.kind === 'add' ? '+' : '-', text: l.text, noEol });
      return;
    }
    // Unselected: it stays only when it exists on the base side.
    const onBase = reverse ? l.kind === 'add' : l.kind === 'del';
    if (onBase) entries.push({ sign: ' ', text: l.text, noEol });
  });

  // A context line without a newline can only be the last line of a hunk. In the middle it becomes -x / marker / +x.
  const body: Entry[] = [];
  entries.forEach((e, i) => {
    if (e.sign === ' ' && e.noEol && i < entries.length - 1) {
      body.push({ sign: '-', text: e.text, noEol: true }, { sign: '+', text: e.text, noEol: false });
    } else {
      body.push(e);
    }
  });

  const oldLines = body.filter((e) => e.sign !== '+').length;
  const newLines = body.filter((e) => e.sign !== '-').length;
  // Counts above zero need a start of at least 1 (the original may say 0 for an empty side).
  const oldStart = oldLines > 0 ? Math.max(1, hunk.oldStart) : hunk.oldStart;
  const newStart = newLines > 0 ? Math.max(1, hunk.newStart) : hunk.newStart;
  const section = hunk.section !== undefined && hunk.section !== '' ? ` ${hunk.section}` : '';

  const a = cQuote('a/', file.path);
  const b = cQuote('b/', file.path);
  const oldIsNothing = file.status === 'A' && oldLines === 0;
  const newIsNothing = file.status === 'D' && newLines === 0;
  const out: string[] = [`diff --git ${a} ${b}`];
  if (oldIsNothing) out.push(`new file mode ${modeOf(file, 'new')}`);
  if (newIsNothing) out.push(`deleted file mode ${modeOf(file, 'deleted')}`);
  out.push(`--- ${oldIsNothing ? '/dev/null' : a}`, `+++ ${newIsNothing ? '/dev/null' : b}`);
  out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${section}`);
  for (const e of body) {
    out.push(`${e.sign}${e.text}`);
    if (e.noEol) out.push(NOEOL);
  }
  return out.join('\n') + '\n';
}
