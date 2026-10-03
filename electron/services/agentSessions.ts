import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../../shared/ipc';

const MAX_SCAN = 400;
const HEAD_BYTES = 64 * 1024;

/** Read the first ~64 KB of a file as lines (sessions can be huge; we only need the head). */
function headLines(file: string): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n).split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) =>
    path
      .resolve(s)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

/** Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl; records carry `cwd`. */
function claudeSessions(projectPath: string): AgentSession[] {
  const out: AgentSession[] = [];
  const base = path.join(os.homedir(), '.claude', 'projects');
  for (const file of walk(base, 1)) {
    if (out.length >= MAX_SCAN) break;
    try {
      let cwd = '';
      let title = '';
      let id = path.basename(file, '.jsonl');
      for (const line of headLines(file)) {
        if (!line.trim()) continue;
        let rec: { sessionId?: string; cwd?: string; type?: string; message?: { role?: string; content?: unknown } };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.sessionId) id = rec.sessionId;
        if (rec.cwd) cwd = rec.cwd;
        if (!title && rec.type === 'user' && rec.message?.role === 'user') {
          const c = rec.message.content;
          const text =
            typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x?.type === 'text')?.text ?? '') : '';
          if (typeof text === 'string' && text.trim() && !text.startsWith('<')) title = text.trim().slice(0, 140);
        }
        if (cwd && title) break;
      }
      if (!cwd || !samePath(cwd, projectPath)) continue;
      out.push({
        agent: 'claude',
        id,
        title: title || '(no prompt)',
        cwd,
        at: fs.statSync(file).mtimeMs,
        file,
        resumeArgs: resumeArgsFor('claude', id),
      });
    } catch {
      /* unreadable session: skip */
    }
  }
  return out;
}

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; first line is session_meta with cwd. */
function codexSessions(projectPath: string): AgentSession[] {
  const out: AgentSession[] = [];
  const base = path.join(os.homedir(), '.codex', 'sessions');
  for (const file of walk(base, 4)) {
    if (out.length >= MAX_SCAN) break;
    try {
      let id = '';
      let cwd = '';
      let title = '';
      for (const line of headLines(file)) {
        if (!line.trim()) continue;
        let rec: {
          type?: string;
          payload?: { session_id?: string; id?: string; cwd?: string; type?: string; message?: string };
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === 'session_meta' && rec.payload) {
          id = rec.payload.session_id ?? rec.payload.id ?? '';
          cwd = rec.payload.cwd ?? '';
          if (cwd && !samePath(cwd, projectPath)) break;
        }
        if (!title && rec.type === 'event_msg' && rec.payload?.type === 'user_message' && rec.payload.message)
          title = rec.payload.message.trim().slice(0, 140);
        if (id && cwd && title) break;
      }
      if (!id || !cwd || !samePath(cwd, projectPath)) continue;
      out.push({
        agent: 'codex',
        id,
        title: title || '(no prompt)',
        cwd,
        at: fs.statSync(file).mtimeMs,
        file,
        resumeArgs: resumeArgsFor('codex', id),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Past agent sessions recorded for a project folder, newest first.
 * ponytail: Claude + Codex only (file formats known). Gemini/OpenCode when their on-disk formats are stable.
 */
export function listAgentSessions(projectPath: string, limit = 40): AgentSession[] {
  return [...claudeSessions(projectPath), ...codexSessions(projectPath)].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Args that resume `session` for its agent CLI. */
export function resumeArgsFor(agent: AgentSession['agent'], id: string): string[] {
  return agent === 'claude' ? ['--resume', id] : ['resume', id];
}
