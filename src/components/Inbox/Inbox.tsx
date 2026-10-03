import { useEffect, useRef, useState } from 'react';
import { tailLine } from '../../../shared/activity';

export interface InboxItem {
  id: string;
  title: string;
  agent: string;
  /** Recent ANSI-stripped output tail. */
  tail: string;
}

interface Props {
  items: InboxItem[];
  working: number;
  /** Writes raw keystrokes to the terminal (no Enter added). */
  onReply: (id: string, keys: string) => void;
  onFocus: (id: string) => void;
}

const QUICK: [label: string, keys: string][] = [
  ['y', 'y\r'],
  ['n', 'n\r'],
  ['Enter', '\r'],
  ['Esc', '\x1b'],
];

/** Last few meaningful lines of the tail, so the question has context. */
function excerpt(tail: string): string[] {
  const lines = tail
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-4);
}

/** Attention Inbox: every pane that is waiting on you, answerable without switching panes. */
export function Inbox({ items, working, onReply, onFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);

  if (!items.length && !working) return null;

  return (
    <div className="inbox" ref={ref}>
      <button
        type="button"
        className={items.length ? 'inbox-btn has-items' : 'inbox-btn'}
        onClick={() => items.length && setOpen((v) => !v)}
        title={items.length ? 'Agents waiting on you' : 'Crew activity'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {working > 0 && (
          <span className="activity activity--working">
            <i aria-hidden="true" />
            {working} working
          </span>
        )}
        {items.length > 0 && (
          <span className="activity activity--waiting">
            <i aria-hidden="true" />
            {items.length} need you
          </span>
        )}
      </button>
      {open && (
        <div className="inbox-pop" role="dialog" aria-label="Attention inbox">
          <div className="inbox-head">
            Attention inbox <span className="muted">answer without switching panes</span>
          </div>
          <ul>
            {items.map((it) => (
              <li key={it.id} data-agent={it.agent}>
                <button type="button" className="inbox-title" onClick={() => onFocus(it.id)} title="Go to pane">
                  {it.title}
                </button>
                <pre className="inbox-excerpt">{excerpt(it.tail).join('\n') || tailLine(it.tail)}</pre>
                <div className="inbox-actions">
                  {QUICK.map(([label, keys]) => (
                    <button key={label} type="button" onClick={() => onReply(it.id, keys)}>
                      {label}
                    </button>
                  ))}
                  <input
                    placeholder="type a reply…"
                    value={typed[it.id] ?? ''}
                    onChange={(e) => setTyped({ ...typed, [it.id]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      onReply(it.id, (typed[it.id] ?? '') + '\r');
                      setTyped({ ...typed, [it.id]: '' });
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
