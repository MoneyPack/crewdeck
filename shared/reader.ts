import type { GitDiffResult } from './ipc';

/** Splits a multi-file unified patch into single-file GitDiffResults. */
export function splitPatch(patch: string): GitDiffResult[] {
  const out: GitDiffResult[] = [];
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.trim());
  for (const p of parts) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
    out.push({ path: m ? m[2] : 'file', patch: p, binary: /^Binary files/m.test(p), truncated: false });
  }
  return out;
}

export type ReaderBlock = { kind: 'code' | 'h' | 'li' | 'p'; text: string };

/**
 * Reader mode: terminal buffer -> readable blocks. Collapses TUI noise (box-drawing, spinner
 * frames, blank runs), renders fenced code, headings and bullets. ponytail: no markdown lib.
 */
const NOISE = /^[\s│┃┆┊╎─━┄┈╌═╔╗╚╝╠╣╦╩╬┌┐└┘╭╮╯╰├┤┬┴┼▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓⠀-⣿◐◓◑◒·•…]*$/;
const SPINNER = /^[⠀-⣿◐◓◑◒]\s/;

export function toBlocks(text: string): ReaderBlock[] {
  const out: ReaderBlock[] = [];
  let code: string[] | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      flush();
      if (code) {
        out.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const t = line.trim();
    if (NOISE.test(line) || SPINNER.test(t)) {
      flush();
      continue;
    }
    if (/^#{1,3}\s/.test(t)) {
      flush();
      out.push({ kind: 'h', text: t.replace(/^#+\s/, '') });
    } else if (/^([-*•]|\d+[.)])\s/.test(t)) {
      flush();
      out.push({ kind: 'li', text: t.replace(/^([-*•]|\d+[.)])\s/, '') });
    } else para.push(t);
  }
  flush();
  if (code) out.push({ kind: 'code', text: code.join('\n') });
  return out;
}

