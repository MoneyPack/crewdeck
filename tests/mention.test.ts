import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROADCAST_HANDLE, mentionCompletions, mentionHandles, parseMention, slugify } from '../shared/mention';

const terms = [
  { id: 't1', title: 'Claude' },
  { id: 't2', title: 'Codex' },
  { id: 't3', title: 'Claude' },
  { id: 't4', title: 'All' },
];

test('slugify lowercases, collapses separators, falls back to term', () => {
  assert.equal(slugify('Claude Code'), 'claude-code');
  assert.equal(slugify('  --Gemini!!  '), 'gemini');
  assert.equal(slugify('build_1.2'), 'build_1.2');
  assert.equal(slugify('Überprüfung'), 'überprüfung');
  assert.equal(slugify('!!!'), 'term');
  assert.equal(slugify(''), 'term');
});

test('mentionHandles dedupes and reserves @all', () => {
  assert.deepEqual(
    mentionHandles(terms).map((t) => t.handle),
    ['claude', 'codex', 'claude-2', 'all-2'],
  );
  assert.equal(BROADCAST_HANDLE, 'all');
});

test('mentionCompletions filters by prefix, case-insensitive, includes all', () => {
  assert.deepEqual(mentionCompletions('@CL', terms), ['claude', 'claude-2']);
  assert.deepEqual(mentionCompletions('a', terms), ['all-2', 'all']);
  assert.equal(mentionCompletions('', terms).length, 5);
  assert.deepEqual(mentionCompletions('zz', terms), []);
});

test('parseMention: single and multiple targets', () => {
  const r = parseMention('  @claude fix the test  ', terms);
  assert.ok(r.ok);
  assert.deepEqual(
    r.targets.map((t) => t.id),
    ['t1'],
  );
  assert.equal(r.message, 'fix the test');
  assert.equal(r.broadcast, false);

  const m = parseMention('@Claude, @codex: @claude review this', terms);
  assert.ok(m.ok);
  assert.deepEqual(
    m.targets.map((t) => t.id),
    ['t1', 't2'],
  );
  assert.equal(m.message, 'review this');

  const glued = parseMention('@claude,@codex hi', terms);
  assert.ok(glued.ok);
  assert.deepEqual(
    glued.targets.map((t) => t.id),
    ['t1', 't2'],
  );
});

test('parseMention: message keeps inner @ and whitespace', () => {
  const r = parseMention('@codex email me@x.io\n  line2', terms);
  assert.ok(r.ok);
  assert.equal(r.message, 'email me@x.io\n  line2');
});

test('parseMention: broadcast targets every terminal', () => {
  const r = parseMention('@all git status', terms);
  assert.ok(r.ok);
  assert.equal(r.broadcast, true);
  assert.deepEqual(
    r.targets.map((t) => t.id),
    ['t1', 't2', 't3', 't4'],
  );

  const r2 = parseMention('@all-2 hi', terms);
  assert.ok(r2.ok);
  assert.deepEqual(
    r2.targets.map((t) => t.id),
    ['t4'],
  );
});

test('parseMention: errors carry spans', () => {
  const noAt = parseMention('  hello', terms);
  assert.equal(noAt.ok, false);
  assert.ok(!noAt.ok && noAt.start === 2 && /Start with/.test(noAt.error));

  const unknown = parseMention('@claude @nope hi', terms);
  assert.ok(!unknown.ok);
  assert.equal(unknown.start, 8);
  assert.equal(unknown.end, 13);
  assert.match(unknown.error, /Unknown terminal @nope .*@claude-2/);

  const empty = parseMention('@ hi', terms);
  assert.ok(!empty.ok && /Missing terminal name/.test(empty.error));

  const noMsg = parseMention('@claude   ', terms);
  assert.ok(!noMsg.ok && noMsg.error === 'Message is empty');

  const noTerms = parseMention('@all hi', []);
  assert.ok(!noTerms.ok && /No terminals/.test(noTerms.error));

  assert.equal(parseMention('', terms).ok, false);
});
