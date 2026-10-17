/** In-memory only: what a running call is doing right now. Never persisted or trusted. */
export type LocalWorkflowCallLive = {
  phase: 'waiting' | 'starting' | 'running' | 'finishing'
  /** While waiting: for a free slot, or for its provider account (Codex, Grok) to be free. */
  reason?: 'slot' | 'account'
  /** Epoch ms when the provider process spawned. */
  startedAt?: number
  /** Short human line, e.g. "Reading src/app.ts", "Thinking…", "Writing the answer". */
  activity?: string
  /** Last ~2 KB of streamed answer (or reasoning) text; provisional, never used for acceptance. */
  tail?: string
  outputChars?: number
  tokens?: { input: number; output: number }
}
