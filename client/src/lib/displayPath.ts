/**
 * A repo path made safe to show in a message, a confirm text or a toast: control characters (including a newline) and bidi
 * characters (override, embedding, isolate and mark characters, which can make "gpj.txt" read as "txt.jpg") and invisible ones
 * (zero-width, soft hyphen, line and paragraph separators, byte order mark, which make two different names look the same) become a visible
 * `<U+XXXX>` escape that names the code point. Everything else is left as it is.
 * (The regex below uses \u escapes only: a raw invisible character in source is invisible to a reader and U+2028 is a line break in it.)
 */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

export function displayPath(p: string): string {
  return p.replace(HIDDEN, (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`);
}
