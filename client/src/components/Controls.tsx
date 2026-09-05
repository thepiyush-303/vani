// ============================================================
// Controls — connect the session, and open or close the mic.
//
// Unmute is unavailable until the session is up, because there is nowhere to
// send audio before that. Each button is named for what happens when you press
// it, and the state readout beside them is in plain words; the raw server
// states are in the log where they are useful for debugging.
// ============================================================

import type { Connection } from '../protocol.ts';

interface Props {
  connection: Connection;
  muted: boolean;
  status: string;
  onToggleConnection: () => void;
  onToggleMute: () => void;
}

export function Controls({ connection, muted, status, onToggleConnection, onToggleMute }: Props) {
  const connected = connection === 'connected';
  const busy = connection === 'connecting';

  return (
    <div className="controls">
      <button className="btn btn--primary" onClick={onToggleConnection} disabled={busy}>
        {connected || busy ? 'Disconnect' : 'Connect'}
      </button>
      <button className="btn" onClick={onToggleMute} disabled={!connected}>
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <p className="controls__status" role="status">
        <span className={`controls__pip is-${connected ? (muted ? 'muted' : 'live') : 'off'}`} aria-hidden="true" />
        {status}
      </p>
    </div>
  );
}
