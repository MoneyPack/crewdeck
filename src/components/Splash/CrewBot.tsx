import { useEffect, useState } from 'react';

/** Original CrewDeck mascot: a small waving crew-bot. Pure SVG + CSS, no deps. */
export const CREW_LINES = [
  'Hey, captain. Your crew is waking up.',
  'Four agents. One deck. Zero tab-switching.',
  'Big ideas ship in small commits. Let’s start one.',
  'Point me at a repo and watch the crew get to work.',
  'Debugging is just exploring with a flashlight. Grab one.',
  'Every great system started as a messy prompt.',
  'Run them in parallel. Compare. Keep the best.',
  'The deck is armed. What are we building today?',
];

export function CrewBot({ size = 96, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`crewbot ${className}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="22" y="30" width="56" height="44" rx="10" fill="var(--ink-3)" stroke="var(--rule-hi)" strokeWidth="2" />
      <rect x="30" y="40" width="40" height="22" rx="5" fill="var(--ink)" />
      <g className="crewbot-eyes">
        <circle cx="41" cy="51" r="3.5" fill="var(--signal)" />
        <circle cx="59" cy="51" r="3.5" fill="var(--signal)" />
      </g>
      <path d="M43 58 Q50 62 57 58" stroke="var(--ok)" strokeWidth="2" fill="none" strokeLinecap="round" />
      <line x1="50" y1="30" x2="50" y2="20" stroke="var(--rule-hi)" strokeWidth="2" />
      <circle className="crewbot-antenna" cx="50" cy="17" r="4" fill="var(--signal)" />
      <rect x="12" y="46" width="10" height="16" rx="4" fill="var(--ink-4)" />
      <g className="crewbot-arm">
        <rect x="70" y="36" width="10" height="22" rx="4" fill="var(--ink-4)" />
        <circle cx="75" cy="34" r="5" fill="var(--info)" />
      </g>
      <rect x="34" y="74" width="12" height="10" rx="3" fill="var(--ink-4)" />
      <rect x="54" y="74" width="12" height="10" rx="3" fill="var(--ink-4)" />
    </svg>
  );
}

/** Rotates through CREW_LINES. ponytail: simple interval, no crossfade queue. */
export function CrewLine({ intervalMs = 3200, className = '' }: { intervalMs?: number; className?: string }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * CREW_LINES.length));
  useEffect(() => {
    const t = window.setInterval(() => setI((n) => (n + 1) % CREW_LINES.length), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return (
    <p key={i} className={`crewline ${className}`}>
      {CREW_LINES[i]}
    </p>
  );
}
