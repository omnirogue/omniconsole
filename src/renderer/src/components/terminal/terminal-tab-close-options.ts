import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import type { PrecomputedTerminalCloseState } from './terminal-close-target'

export type TerminalTabCloseOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseReason
  /** Close reason sent to the host only. Unlike `reason`, it does not skip
   *  local guards (pinned confirmation keys off `reason === 'pty-exit'`),
   *  so lifecycle echoes that still need those guards can tag the wire. */
  hostCloseReason?: TerminalTabCloseReason
  /** PTY whose lifecycle event initiated the host close. */
  lifecyclePtyId?: string
  /** Set by callers that must never raise a modal (bulk closes, CLI/RPC, lifecycle
   *  fallbacks) and by the re-entry that runs once the user confirmed. */
  skipRunningProcessConfirm?: boolean
  captureRecentlyClosed?: boolean
  /** A delete, not a close: the pane's PTY ends even when another tab row still lists it, so
   *  the agent process does not outlive the deleted session. */
  deleteSession?: boolean
  localPtyTeardownOwnedExternally?: boolean
  /** Internal re-entry after the structured provider close is proven. */
  structuredSessionCloseConfirmed?: boolean
  precomputedRetirementPlan?: TerminalTabRetirementPlan
  precomputedCloseState?: PrecomputedTerminalCloseState
  onClosed?: () => void
  onCancel?: () => void
}
