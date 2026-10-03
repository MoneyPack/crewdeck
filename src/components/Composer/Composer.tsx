import { useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import {
  mentionCompletions,
  mentionHandles,
  parseMention,
  type MentionTarget,
  type MentionTerminal,
} from '../../../shared/mention';
import { isPipeline } from '../../../shared/pipeline';

const HISTORY_MAX = 100;

export interface ComposerProps {
  terminals: readonly MentionTerminal[];
  /** Deliver `message` to each target. Return an error string to keep the draft and show it. */
  onSend: (targets: MentionTarget[], message: string) => string | void;
  /** Handles `@a -> @b: task` chains. Return an error string to keep the draft. */
  onPipeline?: (text: string) => string | void;
  ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
  focus(): void;
}

interface Suggest {
  start: number; // index of '@'
  end: number; // caret
  items: string[];
  index: number;
}

/** The `@token` immediately left of the caret, if any. */
function tokenAtCaret(text: string, caret: number): { start: number; prefix: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, prefix: m[2] };
}

export function Composer({ terminals, onSend, onPipeline, ref }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const history = useRef<string[]>([]);
  // Position while browsing history; history.length means "the live draft".
  const historyPos = useRef(0);
  const draft = useRef('');

  const handles = useMemo(() => mentionHandles(terminals), [terminals]);

  const updateSuggest = (value: string, caret: number) => {
    const tok = tokenAtCaret(value, caret);
    if (!tok) return setSuggest(null);
    const items = mentionCompletions(tok.prefix, terminals);
    // Hide when the only completion is exactly what's typed.
    if (items.length === 0 || (items.length === 1 && items[0] === tok.prefix.toLowerCase())) return setSuggest(null);
    setSuggest({ start: tok.start, end: caret, items, index: 0 });
  };

  const setValue = (value: string, caret = value.length) => {
    setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(caret, caret);
    });
  };

  const accept = (handle: string) => {
    if (!suggest) return;
    const insert = `@${handle} `;
    const value = text.slice(0, suggest.start) + insert + text.slice(suggest.end);
    setSuggest(null);
    setValue(value, suggest.start + insert.length);
    inputRef.current?.focus();
  };

  const send = () => {
    let failure: string | void;
    if (onPipeline && isPipeline(text)) {
      failure = onPipeline(text);
    } else {
      const result = parseMention(text, terminals);
      if (!result.ok) {
        setError(result.error);
        inputRef.current?.setSelectionRange(result.start, result.end);
        return;
      }
      failure = onSend(result.targets, result.message);
    }
    if (failure) {
      setError(failure);
      return;
    }
    const h = history.current;
    if (h[h.length - 1] !== text) h.push(text);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
    historyPos.current = h.length;
    draft.current = '';
    setError(null);
    setSuggest(null);
    setText('');
  };

  const recall = (delta: -1 | 1) => {
    const h = history.current;
    const next = historyPos.current + delta;
    if (next < 0 || next > h.length) return false;
    if (historyPos.current === h.length) draft.current = text;
    historyPos.current = next;
    setValue(next === h.length ? draft.current : h[next]);
    setError(null);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;

    if (suggest) {
      const n = suggest.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + d + n) % n });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(suggest.items[suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }

    const caret = el.selectionStart;
    const collapsed = caret === el.selectionEnd;
    if (e.key === 'ArrowUp' && collapsed && !text.slice(0, caret).includes('\n')) {
      if (recall(-1)) e.preventDefault();
    } else if (e.key === 'ArrowDown' && collapsed && !text.slice(caret).includes('\n')) {
      if (recall(1)) e.preventDefault();
    }
  };

  const rows = Math.min(8, Math.max(1, text.split('\n').length));
  const byHandle = new Map(handles.map((t) => [t.handle, t]));

  return (
    <div className="composer">
      {suggest && (
        <ul className="composer-suggest" role="listbox" id="composer-suggest" aria-label="Mention suggestions">
          {suggest.items.map((h, i) => (
            <li
              key={h}
              id={`composer-opt-${i}`}
              role="option"
              aria-selected={i === suggest.index}
              className={i === suggest.index ? 'selected' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(h);
              }}
            >
              <span className="handle">@{h}</span>
              <span className="hint">{h === 'all' ? 'every terminal' : byHandle.get(h)?.title}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="composer-input"
        aria-label="Message terminals"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!suggest}
        aria-controls="composer-suggest"
        aria-activedescendant={suggest ? `composer-opt-${suggest.index}` : undefined}
        rows={rows}
        spellCheck={false}
        value={text}
        placeholder={
          handles.length > 1
            ? `@${handles[0].handle} message…  or  @${handles[0].handle} -> @${handles[1].handle}: pipeline  (Enter send · ↑↓ history)`
            : handles.length
              ? `@${handles[0].handle} message…  (Enter send · Shift+Enter newline · ↑↓ history)`
              : 'Open a terminal to send messages'
        }
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          historyPos.current = history.current.length;
          updateSuggest(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          if (suggest && el.selectionStart !== suggest.end) updateSuggest(el.value, el.selectionStart);
        }}
        onBlur={() => setSuggest(null)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
