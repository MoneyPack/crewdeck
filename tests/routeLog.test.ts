import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROUTE_LABEL, MAX_ROUTE_TARGETS, parseRouteInput } from '../shared/routeLog';
import { ROUTE_PREVIEW_LIMIT } from '../shared/ipc';

const base = { kind: 'composer', fromLabel: 'you', targets: ['claude'], preview: 'hi', bytes: 2, viaFile: false };

test('accepts a well-formed input and copies targets', () => {
  const targets = ['claude', 'codex'];
  const out = parseRouteInput({ ...base, kind: 'forward', targets });
  assert.deepEqual(out, { kind: 'forward', fromLabel: 'you', targets: ['claude', 'codex'], preview: 'hi', bytes: 2, viaFile: false });
  assert.notEqual(out!.targets, targets);
});

test('rejects non-objects and bad kinds/labels/preview', () => {
  for (const raw of [null, undefined, 42, 'x']) assert.equal(parseRouteInput(raw), null);
  assert.equal(parseRouteInput({ ...base, kind: 'broadcast' }), null);
  assert.equal(parseRouteInput({ ...base, fromLabel: '' }), null);
  assert.equal(parseRouteInput({ ...base, fromLabel: 7 }), null);
  assert.equal(parseRouteInput({ ...base, preview: undefined }), null);
});

test('validates targets', () => {
  assert.equal(parseRouteInput({ ...base, targets: [] }), null);
  assert.equal(parseRouteInput({ ...base, targets: 'claude' }), null);
  assert.equal(parseRouteInput({ ...base, targets: [''] }), null);
  assert.equal(parseRouteInput({ ...base, targets: [1] }), null);
  assert.equal(parseRouteInput({ ...base, targets: ['x'.repeat(MAX_ROUTE_LABEL + 1)] }), null);
  assert.equal(parseRouteInput({ ...base, targets: Array(MAX_ROUTE_TARGETS + 1).fill('a') }), null);
  assert.ok(parseRouteInput({ ...base, targets: Array(MAX_ROUTE_TARGETS).fill('a') }));
});

test('truncates label and preview', () => {
  const out = parseRouteInput({ ...base, fromLabel: 'l'.repeat(1000), preview: 'p'.repeat(1000) })!;
  assert.equal(out.fromLabel.length, MAX_ROUTE_LABEL);
  assert.equal(out.preview.length, ROUTE_PREVIEW_LIMIT);
});

test('normalises bytes and viaFile', () => {
  assert.equal(parseRouteInput({ ...base, bytes: 3.9 })!.bytes, 3);
  for (const bytes of [-1, NaN, Infinity, '5', undefined]) assert.equal(parseRouteInput({ ...base, bytes })!.bytes, 0);
  assert.equal(parseRouteInput({ ...base, viaFile: 'true' })!.viaFile, false);
  assert.equal(parseRouteInput({ ...base, viaFile: true })!.viaFile, true);
});
