import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, looksWaiting, tailLine, WORKING_WINDOW_MS } from '../shared/activity';
import { advance, isPipeline, parsePipeline, stagePrompt } from '../shared/pipeline';

const terms = [
  { id: 't1', title: 'Claude' },
  { id: 't2', title: 'Codex' },
  { id: 't3', title: 'Gemini' },
];

test('tailLine strips ANSI and returns last non-empty line', () => {
  assert.equal(tailLine('foo\r\n\x1b[32mbar\x1b[0m\r\n\r\n'), 'bar');
  assert.equal(tailLine(''), '');
});

test('looksWaiting detects prompts and permission asks', () => {
  assert.equal(looksWaiting('Done.\n> '), true);
  assert.equal(looksWaiting('Allow this tool to run? (y/n)'), true);
  assert.equal(looksWaiting('Compiling 12 files...'), false);
});

test('classify: working within window, then waiting/idle, off when dead', () => {
  const now = 10_000;
  assert.equal(classify(now, now - 100, 'x', true), 'working');
  assert.equal(classify(now, now - WORKING_WINDOW_MS - 1, 'all good\n$ ', true), 'waiting');
  assert.equal(classify(now, now - WORKING_WINDOW_MS - 1, 'still building', true), 'idle');
  assert.equal(classify(now, now - 100, 'x', false), 'off');
});

test('pipeline parses chain, builds stage prompts, advances on work->idle', () => {
  assert.equal(isPipeline('@claude -> @codex: build it'), true);
  assert.equal(isPipeline('@claude build it'), false);
  const r = parsePipeline('@claude -> @codex -> @gemini: build the login page', terms);
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = r.pipeline;
  assert.deepEqual(p.stages, ['t1', 't2', 't3']);
  assert.equal(stagePrompt(p, 0), 'build the login page');

  assert.equal(advance(p, 't2', 'idle', ''), null, 'ignores non-current stage');
  assert.equal(advance(p, 't1', 'idle', ''), null, 'idle before any work does not advance');
  assert.equal(advance(p, 't1', 'working', ''), null);
  assert.equal(advance(p, 't1', 'waiting', 'plan: 3 steps'), 1);
  assert.match(stagePrompt(p, 1), /Output from @claude[\s\S]*plan: 3 steps/);
  assert.equal(advance(p, 't2', 'working', ''), null);
  assert.equal(advance(p, 't2', 'idle', 'patch applied'), 2);
  assert.equal(advance(p, 't3', 'working', ''), null);
  assert.equal(advance(p, 't3', 'idle', 'LGTM'), 'done');

  const bad = parsePipeline('@claude -> @nope: x', terms);
  assert.ok(!bad.ok && /unknown terminal @nope/.test(bad.error));
});
