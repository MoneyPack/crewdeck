import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTokens, NO_USAGE, scanUsage } from '../shared/usage';
import { splitPatch, toBlocks } from '../shared/reader';

test('scanUsage takes max cumulative usd/tokens, ignores junk', () => {
  let u = scanUsage(NO_USAGE, 'Total cost: $0.42  tokens used: 12,340');
  assert.deepEqual(u, { usd: 0.42, tokens: 12340 });
  u = scanUsage(u, 'Total cost: $1.10 · 45.2k tokens');
  assert.deepEqual(u, { usd: 1.1, tokens: 45200 });
  u = scanUsage(u, 'price was $99999 in the docs'); // > cap, ignored
  assert.equal(u.usd, 1.1);
  assert.equal(scanUsage(NO_USAGE, 'no numbers here'), NO_USAGE);
  assert.equal(fmtTokens(45200), '45.2k');
  assert.equal(fmtTokens(1_250_000), '1.3M');
});

test('splitPatch separates files from a multi-file unified diff', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.md b/b.md\nnew file mode 100644\n--- /dev/null\n+++ b/b.md\n@@ -0,0 +1 @@\n+hi\n';
  const files = splitPatch(patch);
  assert.deepEqual(
    files.map((f) => f.path),
    ['a.ts', 'b.md'],
  );
  assert.ok(files[1].patch.includes('+hi'));
});

test('toBlocks drops TUI noise and keeps code fences, headings, bullets', () => {
  const b = toBlocks('╭────╮\n⠋ thinking\n# Plan\n- step one\n- step two\n```\nconst x = 1;\n```\nDone.\n');
  assert.deepEqual(
    b.map((x) => x.kind),
    ['h', 'li', 'li', 'code', 'p'],
  );
  assert.equal(b[3].text, 'const x = 1;');
});
