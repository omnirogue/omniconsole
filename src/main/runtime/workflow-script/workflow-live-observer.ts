/**
 * In-memory live signals for a running workflow call. Nothing here is persisted, trusted or used
 * for acceptance: durable state stays in the checkpoint store; this only feeds the live view.
 */
export type WorkflowLiveUpdate = {
  /** Short human line such as "Reading src/app.ts" or "Thinking…". */
  activity?: string
  /** Text delta to append to the call's rolling tail (answer or reasoning text). */
  text?: string
  /** Cumulative provider-reported tokens so far. */
  tokens?: { input: number; output: number }
}

export type WorkflowLiveObserver = {
  /** The call is waiting for a host slot or an account lock. */
  waiting: (callId: string, reason: 'slot' | 'account') => void
  /** An attempt was reserved and its process is being prepared. */
  starting: (callId: string, attemptId: string) => void
  /** The provider process spawned. */
  spawned: (callId: string, attemptId: string, at: number) => void
  /** Parsed from streamed provider output. */
  update: (callId: string, attemptId: string, update: WorkflowLiveUpdate) => void
  /** The provider process exited; acceptance may still be pending. */
  exited: (callId: string, attemptId: string, at: number) => void
}

export const NOOP_WORKFLOW_LIVE_OBSERVER: WorkflowLiveObserver = {
  waiting: () => {},
  starting: () => {},
  spawned: () => {},
  update: () => {},
  exited: () => {}
}
