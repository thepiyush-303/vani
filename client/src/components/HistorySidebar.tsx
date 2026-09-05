// ============================================================
// HistorySidebar — the durable transcript, both sides, across sessions.
//
// One running conversation, oldest first: user and assistant turns as they were
// said, with a thin divider wherever one session ends and the next begins. The
// turns are loaded from the server on connect (SQLite-backed) and appended to as
// this session goes. Slides in from the left — the log lives on the right — and
// closes on Escape.
// ============================================================

import { Fragment, useEffect, useRef } from 'react';
import type { PersistedTurn } from '../protocol.ts';

interface Props {
  turns: PersistedTurn[];
  open: boolean;
  onClose: () => void;
}

export function HistorySidebar({ turns, open, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the tail while open — the newest turn is what you came back for.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, turns]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <aside className={open ? 'history is-open' : 'history'} role="complementary" aria-label="Conversation history" aria-hidden={!open}>
      <header className="history__head">
        <span className="history__title">History</span>
        <button className="history__close" onClick={onClose} aria-label="Close history" tabIndex={open ? 0 : -1}>
          ×
        </button>
      </header>
      <div className="history__scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <p className="history__empty">No conversations yet. Everything you say and hear lands here.</p>
        ) : (
          turns.map((turn, i) => {
            // A new session_id after the previous turn means a session boundary.
            const boundary = i > 0 && turns[i - 1].session_id !== turn.session_id;
            return (
              <Fragment key={i}>
                {boundary && <div className="history__break" role="separator" aria-label="New session" />}
                <div className={`turn turn--${turn.role}`}>
                  <span className="turn__who">{turn.role === 'user' ? 'You' : 'Vani'}</span>
                  <p className="turn__text">{turn.content}</p>
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </aside>
  );
}
