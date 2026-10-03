/**
 * Agent pipelines: `@planner -> @coder -> @reviewer: build the login page`.
 * Each stage gets the task plus the previous stage's output tail. Advancing is driven
 * by the pane's activity heuristic (a stage is done when it goes working -> idle/waiting).
 * ponytail: linear chain only, no fan-out/DAG; upgrade when someone asks for branches.
 */
import type { MentionTerminal } from './mention';
import { mentionHandles } from './mention';

export interface Pipeline {
  /** Terminal ids in order. */
  stages: string[];
  handles: string[];
  task: string;
  /** Index of the stage currently running. */
  current: number;
  /** Set once the current stage has been seen working, so idle before start doesn't advance. */
  started: boolean;
  /** Output tail from the last finished stage. */
  lastOutput: string;
}

export const PIPE_RE = /^\s*(@[\w-]+(?:\s*->\s*@[\w-]+)+)\s*:\s*([\s\S]+)$/;

export function isPipeline(text: string): boolean {
  return PIPE_RE.test(text);
}

export function parsePipeline(
  text: string,
  terminals: readonly MentionTerminal[],
): { ok: true; pipeline: Pipeline } | { ok: false; error: string } {
  const m = PIPE_RE.exec(text);
  if (!m) return { ok: false, error: 'pipeline syntax: @a -> @b -> @c: task' };
  const handles = m[1].split('->').map((s) => s.trim().slice(1).toLowerCase());
  const byHandle = new Map(mentionHandles(terminals).map((t) => [t.handle, t.id] as const));
  const stages: string[] = [];
  for (const h of handles) {
    const id = byHandle.get(h);
    if (!id) return { ok: false, error: `unknown terminal @${h}` };
    stages.push(id);
  }
  return {
    ok: true,
    pipeline: { stages, handles, task: m[2].trim(), current: 0, started: false, lastOutput: '' },
  };
}

/** Prompt handed to stage `i`. */
export function stagePrompt(p: Pipeline, i: number): string {
  if (i === 0) return p.task;
  const prev = p.handles[i - 1];
  return `You are stage ${i + 1} of ${p.stages.length} in a pipeline. Original task:\n${p.task}\n\nOutput from @${prev} (previous stage):\n${p.lastOutput}\n\nContinue the work from where @${prev} left off.`;
}

/**
 * Feed an activity transition for a terminal. Returns the next stage index to launch,
 * `'done'` when the chain finished, or `null` for no change.
 */
export function advance(
  p: Pipeline,
  terminalId: string,
  activity: 'working' | 'waiting' | 'idle' | 'off',
  tail: string,
): number | 'done' | null {
  if (p.stages[p.current] !== terminalId) return null;
  if (activity === 'working') {
    p.started = true;
    return null;
  }
  if (!p.started || activity === 'off') return null;
  // idle or waiting after having worked: stage finished.
  p.lastOutput = tail;
  p.started = false;
  p.current += 1;
  return p.current >= p.stages.length ? 'done' : p.current;
}
