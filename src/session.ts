// ============================================================
// session.ts — SessionContext factory and store
// Single-user per PRD §1.2 (no multi-tenancy on local hardware)
// ============================================================

import { SessionContext, ServerState } from './types';

export function createSession(sessionId: string): SessionContext {
  return {
    sessionId,
    state: ServerState.IDLE,
    audioBuffer: [],
    conversationHistory: [
      {
        role: 'system',
        content: [
          'You are a helpful voice assistant.',
          'Respond concisely in 1-2 sentences.',
          'For tool calls, extract all required parameters before calling.',
          'If required parameters are missing, ask for them conversationally before calling the tool.',
        ].join(' '),
      },
    ],
    tokenCount: 0,
    turnStartedAt: null,
    createdAt: Date.now(),
  };
}

// Single active session — enforced at connection time in server.ts
let activeSession: SessionContext | null = null;

export const SessionStore = {
  set(ctx: SessionContext): void {
    activeSession = ctx;
  },

  get(): SessionContext | null {
    return activeSession;
  },

  getOrThrow(): SessionContext {
    if (!activeSession) {
      throw new Error('No active session');
    }
    return activeSession;
  },

  clear(): void {
    if (activeSession) {
      console.log(`[session] Session ${activeSession.sessionId} cleared`);
    }
    activeSession = null;
  },

  has(): boolean {
    return activeSession !== null;
  },
};
