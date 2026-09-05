// ============================================================
// LogSidebar — the event stream, out of the way until you want it.
//
// Same content the prototype printed into a box on the page: every message in
// and out, plus client-side notes. It slides in from the right and closes on
// Escape.
// ============================================================

import { useEffect, useRef } from 'react';
import type { LogEntry } from '../protocol.ts';

interface Props {
  entries: LogEntry[];
  open: boolean;
  onClose: () => void;
}

export function LogSidebar({ entries, open, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the tail while open.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, entries]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <aside className={open ? 'logs is-open' : 'logs'} role="complementary" aria-label="Event log" aria-hidden={!open}>
      <header className="logs__head">
        <span className="logs__title">Event log</span>
        <button className="logs__close" onClick={onClose} aria-label="Close event log" tabIndex={open ? 0 : -1}>
          ×
        </button>
      </header>
      <div className="logs__scroll" ref={scrollRef}>
        {entries.length === 0 ? (
          <p className="logs__empty">Nothing yet. Connect to start a session.</p>
        ) : (
          entries.map((entry) => (
            <p className={`logs__line is-${entry.kind}`} key={entry.id}>
              <span className="logs__at">{entry.at}</span>
              {entry.text}
            </p>
          ))
        )}
      </div>
    </aside>
  );
}
