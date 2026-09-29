import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

export function Palette({ open, actions, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[index]);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        <ul role="listbox">
          {filtered.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'active' : undefined}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(a);
              }}
            >
              <span>{a.label}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </li>
          ))}
          {filtered.length === 0 && <li aria-disabled="true">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
