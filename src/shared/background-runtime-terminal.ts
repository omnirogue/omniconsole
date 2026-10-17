/**
 * A runtime-owned terminal that no window tab shows: running in the background, not in a window
 * (for example a process an earlier click from another computer started). Read by the local CLI
 * (`session list`, `session tidy`) and by the owner's Conversations sidebar; never sent to peers.
 */
export type BackgroundRuntimeTerminal = {
  ptyId: string
  worktreeId: string
  tabId: string | null
  paneKey: string | null
  /** The live `omni terminal` handle. */
  handle: string
  title: string | null
  launchAgent: string | null
  hostId: string
}

/** Main ↔ own window only: the background terminals this computer runs, or null when unknown. */
export const LIST_BACKGROUND_TERMINALS_CHANNEL = 'runtime:listBackgroundTerminals'

/** Main ↔ own window only: a person ends one, re-checked and audited. Request: `{ ptyId }`. */
export const END_BACKGROUND_TERMINAL_CHANNEL = 'runtime:endBackgroundTerminal'

export type EndBackgroundTerminalReply = {
  ended: true
  ptyKilled: boolean
  /** The terminal ended but its audit line could not be written. */
  auditError?: string
}
