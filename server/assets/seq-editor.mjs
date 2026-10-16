// GitSlappin sequence editor for `git rebase -i` (V4). Called by git as: node seq-editor.mjs <source> <target>.
// <target> is git's own todo file; <source> is a todo the server wrote under <dataDir>/rebase-todo/. The bytes are copied over, nothing else runs.
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const LINE = /^(?:(?:pick|fixup|drop) [0-9a-f]{40,64}|#.*|)\r?$/;

function fail(text) {
  process.stderr.write(`gitslappin sequence editor: ${text}\n`);
  process.exit(1);
}

const [source, target] = process.argv.slice(2);
if (!source || !target || process.argv.length !== 4) fail('expected a source and a target.');
if (basename(target) !== 'git-rebase-todo') fail('the target is not a rebase todo file.');
let real;
try {
  real = realpathSync(source);
  if (!statSync(real).isFile()) fail('the source is not a file.');
} catch {
  fail('the source cannot be read.');
}
if (basename(dirname(real)) !== 'rebase-todo') fail('the source is not in a rebase-todo folder.');
const bytes = readFileSync(real);
if (!bytes.toString('latin1').split('\n').every((l) => LINE.test(l))) fail('the source holds more than pick, fixup and drop lines.');
writeFileSync(target, bytes);
