import { useEffect, useRef } from 'react';
import { toBlocks } from '../../../shared/reader';

export function Reader({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const blocks = toBlocks(text);
  // Follow the tail like the terminal does.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="reader" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <div className="reader-bar">
        <span>Reader</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close reader">
          <i className="ri-close-line" aria-hidden="true" />
        </button>
      </div>
      {blocks.length === 0 && <p className="muted">Nothing to read yet.</p>}
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          <pre key={i}>{b.text}</pre>
        ) : b.kind === 'h' ? (
          <h3 key={i}>{b.text}</h3>
        ) : b.kind === 'li' ? (
          <li key={i}>{b.text}</li>
        ) : (
          <p key={i}>{b.text}</p>
        ),
      )}
    </div>
  );
}
