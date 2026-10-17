/** The shape every native-chat send path returns, and the options it accepts.
 *  Kept apart from the send implementations so the queue-backed path and the
 *  direct-write paths can share them without importing each other. */

import type { TuiAgent } from '../../../../shared/tui-agent'

export type NativeChatSendOptions = {
  /** Native input behavior of the agent that owns this composer. */
  agent?: TuiAgent
  /** Bytes that empty the agent's input line. Defaults to a single Ctrl+U. */
  clearInput?: string
  /**
   * Observed check that the input line is now empty.
   * Supplied only for launch-draft replacement; when it reports "not cleared"
   * the send widens to a maximal burst before writing the body rather than
   * pasting on top of residue.
   */
  confirmCleared?: () => boolean
  /**
   * A deliberate repeat of text just sent. Without it, identical text from this
   * origin inside the duplicate window is refused rather than delivered twice.
   */
  force?: boolean
}

/** Cancels an in-flight send's remaining writes. Safe to call after it completes. */
export type NativeChatSendHandle = {
  cancel: () => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
  wasSubmitted?: () => boolean
  /** Cancels, then resolves whether the text had already been delivered; either way nothing more
   *  is written afterwards, so a false result is safe to retry. */
  cancelAndConfirm?: () => Promise<boolean>
}
