import { SessionContext } from './types';
export declare function createSession(sessionId: string): SessionContext;
export declare const SessionStore: {
    set(ctx: SessionContext): void;
    get(): SessionContext | null;
    getOrThrow(): SessionContext;
    clear(): void;
    has(): boolean;
};
//# sourceMappingURL=session.d.ts.map