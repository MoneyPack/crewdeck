import { useEffect, useRef } from 'react';
import { SHORTCUT_GROUPS, SHORTCUTS, formatCombo, type Combo } from '../../../shared/shortcuts';

export interface ShortcutHelpProps {
  mac: boolean;
  onClose: () => void;
}

/** Key caps for one combo, e.g. [Ctrl][Shift][T]. */
export function Keys({ combo, mac }: { combo: Combo; mac: boolean }) {
  return (
    <span className="keys">
      {formatCombo(combo, mac).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

/** Modal cheat sheet of every app shortcut, grouped. Esc, backdrop click or F1 closes it. */
export function ShortcutHelp({ mac, onClose }: ShortcutHelpProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Remember what had focus (usually a terminal) and hand it back on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="shortcut-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <header>
          <i className="ri-keyboard-box-line" aria-hidden="true" />
          <h2 id="shortcut-title">Keyboard</h2>
          <span className="spacer" />
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            title="Close (Esc)"
            aria-label="Close"
            onClick={onClose}
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </header>
        <div className="shortcut-groups">
          {SHORTCUT_GROUPS.map((group, gi) => (
            <section key={group} style={{ animationDelay: `${gi * 40}ms` }}>
              <h3>
                <span className="idx">{String(gi + 1).padStart(2, '0')}</span>
                {group}
              </h3>
              <dl>
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.action} className="row" data-action={s.action}>
                    <dt>{s.label}</dt>
                    <dd>
                      {s.combos.map((c, i) => (
                        <Keys key={i} combo={c} mac={mac} />
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer>
          Shortcuts work inside terminals too. Composer: <kbd>Tab</kbd> accepts a mention, <kbd>Enter</kbd> sends,{' '}
          <kbd>{mac ? '⇧' : 'Shift'}</kbd>
          <kbd>Enter</kbd> adds a line.
        </footer>
      </div>
    </div>
  );
}
