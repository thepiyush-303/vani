import { ServerState, SideEffectName, IncomingEventType } from './types';
export interface TransitionResult {
    nextState: ServerState;
    sideEffects: SideEffectName[];
}
export interface TransitionError {
    code: 'INVALID_STATE';
    message: string;
}
export type TransitionOutcome = TransitionResult | TransitionError;
export declare function isTransitionError(r: TransitionOutcome): r is TransitionError;
/**
 * Pure state machine transition.
 * Returns the next state and a list of named side-effects to execute.
 * Never performs I/O itself.
 */
export declare function transition(currentState: ServerState, event: IncomingEventType): TransitionOutcome;
//# sourceMappingURL=stateMachine.d.ts.map