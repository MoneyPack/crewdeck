import { useMemo } from 'react';
import type { GitDiffResult } from '../../../shared/ipc';
import { langForPath, tokenizeLine } from './highlight';

export type DiffMode = 'unified' | 'split';

type LineKind = 'ctx' | 'add' | 'del';

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

interface ParsedPatch {
  /** File-level header lines (diff --git, index, ---/+++, mode changes). */
  meta: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a single-file unified patch into hunks with old/new line numbers. */
export function parsePatch(patch: string): ParsedPatch {
  const meta: string[] = [];
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split('\n');
  // A trailing newline yields one empty element that is not a diff line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!cur) {
      meta.push(line);
      continue;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '+') cur.lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
    else if (sign === '-') cur.lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
    else if (sign === ' ' || line === '') cur.lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    // "\ No newline at end of file" and anything unknown is skipped.
  }
  return { meta, hunks };
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs each run of deletions with the run of additions that follows it. */
function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const { lines } = hunk;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'ctx') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

interface Props {
  diff: GitDiffResult | null;
  loading: boolean;
  error: string | null;
  mode: DiffMode;
}

function Num({ n }: { n: number | null }) {
  return <span className="diff-no">{n ?? ''}</span>;
}

function Code({ text, lang }: { text: string; lang: string | null }) {
  const toks = tokenizeLine(text, lang);
  return (
    <span className="diff-text">
      {toks.length === 1 && toks[0].kind === 'plain'
        ? text
        : toks.map((t, i) =>
            t.kind === 'plain' ? (
              t.text
            ) : (
              <span className={`tok-${t.kind}`} key={i}>
                {t.text}
              </span>
            ),
          )}
    </span>
  );
}

/** Renders a unified patch as either a unified or side-by-side table. */
export function DiffViewer({ diff, loading, error, mode }: Props) {
  const parsed = useMemo(() => (diff ? parsePatch(diff.patch) : null), [diff]);
  const lang = useMemo(() => (diff ? langForPath(diff.path) : null), [diff]);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const h of parsed?.hunks ?? []) {
      for (const l of h.lines) {
        if (l.kind === 'add') add++;
        else if (l.kind === 'del') del++;
      }
    }
    return { add, del };
  }, [parsed]);

  if (error) return <div className="diff-notice error">{error}</div>;
  if (loading && !diff) return <div className="diff-notice">Loading diff…</div>;
  if (!diff || !parsed) return <div className="diff-notice">Select a file to view its diff.</div>;
  if (diff.binary) return <div className="diff-notice">Binary file — no text diff.</div>;
  if (!parsed.hunks.length) {
    return (
      <div className="diff-notice">
        {parsed.meta.some((m) => /^(old|new) mode|^similarity index|^rename /.test(m))
          ? parsed.meta.filter((m) => /^(old|new) mode|^similarity|^rename /.test(m)).join('\n')
          : 'No textual changes.'}
      </div>
    );
  }

  return (
    <div className={`diff-view ${mode}`}>
      <div className="diff-stats">
        <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
        {diff.truncated && <span className="diff-truncated"> · truncated (patch too large)</span>}
      </div>
      {parsed.hunks.map((h, hi) => (
        <div className="diff-hunk" key={hi}>
          <div className="diff-hunk-header">{h.header}</div>
          {mode === 'unified'
            ? h.lines.map((l, li) => (
                <div className={`diff-line ${l.kind}`} key={li}>
                  <Num n={l.oldNo} />
                  <Num n={l.newNo} />
                  <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
                  <Code text={l.text} lang={lang} />
                </div>
              ))
            : splitRows(h).map((r, ri) => (
                <div className="diff-row" key={ri}>
                  <div className={`diff-line ${r.left ? r.left.kind : 'none'}`}>
                    <Num n={r.left?.oldNo ?? null} />
                    <Code text={r.left?.text ?? ''} lang={lang} />
                  </div>
                  <div className={`diff-line ${r.right ? r.right.kind : 'none'}`}>
                    <Num n={r.right?.newNo ?? null} />
                    <Code text={r.right?.text ?? ''} lang={lang} />
                  </div>
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}
