/**
 * Main → window `terminal:requestTabMount`, and the window's acknowledgement for one exact surface.
 * Main and its window ship in one build, so the reply needs no negotiation; a request without
 * `requestId` keeps the original fire-and-forget behavior.
 */

export const TERMINAL_TAB_MOUNT_REPLY_CHANNEL = 'terminal:tabMountReply'

export type TerminalTabMountRequestPayload = {
  worktreeId: string
  tabId?: string
  ptyId?: string
  /** Main sets it only for a person's own open (the phone's, or an explicit paired tab click). */
  personOpen?: boolean
  /** Present when main awaits an acknowledgement for this exact surface. */
  requestId?: string
  /** The exact leaf that acknowledgement must cover. */
  leafId?: string
}

export type TerminalTabMountOutcome =
  /** That tab's pane is mounted in the window (it spawns or attaches its own PTY). */
  | 'mounted'
  | 'tab_not_found'
  | 'leaf_not_found'
  /** The window accepted the request but the pane did not mount in time. */
  | 'mount_timeout'

export type TerminalTabMountReply = {
  requestId: string
  worktreeId: string
  tabId: string
  leafId?: string
  outcome: TerminalTabMountOutcome
}

export function isTerminalTabMountReply(value: unknown): value is TerminalTabMountReply {
  if (!value || typeof value !== 'object') {
    return false
  }
  const reply = value as Record<string, unknown>
  return (
    typeof reply.requestId === 'string' &&
    typeof reply.worktreeId === 'string' &&
    typeof reply.tabId === 'string' &&
    (reply.leafId === undefined || typeof reply.leafId === 'string') &&
    (reply.outcome === 'mounted' ||
      reply.outcome === 'tab_not_found' ||
      reply.outcome === 'leaf_not_found' ||
      reply.outcome === 'mount_timeout')
  )
}
