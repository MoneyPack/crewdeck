import { useEffect, useState } from 'react';
import logo from '../../assets/logo.svg';

const CREW = [
  { id: 'claude', label: 'CLAUDE' },
  { id: 'codex', label: 'CODEX' },
  { id: 'gemini', label: 'GEMINI' },
  { id: 'opencode', label: 'OPENCODE' },
] as const;

const WORD = 'CREWDECK';
const HOLD_MS = 2400;
const FADE_MS = 420;

export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onDone();
      return;
    }
    const t1 = window.setTimeout(() => setLeaving(true), HOLD_MS);
    const t2 = window.setTimeout(onDone, HOLD_MS + FADE_MS);
    const skip = () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      onDone();
    };
    window.addEventListener('keydown', skip, { once: true });
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener('keydown', skip);
    };
  }, [onDone]);

  return (
    <div className={`splash${leaving ? ' is-leaving' : ''}`} data-testid="splash" role="presentation" onClick={onDone}>
      <div className="splash-scan" aria-hidden="true" />
      <div className="splash-lanes" aria-hidden="true">
        {CREW.map((c, i) => (
          <div
            key={c.id}
            className={`splash-lane splash-lane--${c.id}`}
            style={{ animationDelay: `${120 + i * 110}ms` }}
          >
            <span className="splash-lane-tag">{c.label}</span>
            <span className="splash-lane-bar" />
            <span className="splash-lane-ok">ONLINE</span>
          </div>
        ))}
      </div>
      <img className="splash-logo" src={logo} alt="" />
      <h1 className="splash-word" aria-label="crewdeck">
        {WORD.split('').map((ch, i) => (
          <span key={i} style={{ animationDelay: `${700 + i * 55}ms` }}>
            {ch}
          </span>
        ))}
      </h1>
      <p className="splash-sub">
        <span className="splash-dot" /> CREW ASSEMBLED · DECK ARMED
      </p>
    </div>
  );
}
