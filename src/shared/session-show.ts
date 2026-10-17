/**
 * `omni session show`: pull a conversation into view — beside what the person is looking at
 * (split right in the same workspace, else the Grid with it on the right) or in its place —
 * and light its pane rim and sidebar row.
 */

export const SESSION_SHOW_MODES = ['beside', 'replace'] as const
export type SessionShowMode = (typeof SESSION_SHOW_MODES)[number]

/**
 * split: a new split on the right of the workspace on screen. grid: the Grid, the current view on
 * the left. grid-replaced: the Grid was full, its least recently used pane (never the current one)
 * now shows it. already-shown: it was on screen and is highlighted there. replaced: in place of
 * the current view (`--replace`).
 */
export type SessionShowPlacement = 'split' | 'grid' | 'grid-replaced' | 'already-shown' | 'replaced'

/** What the window did; keptKeyboardFocus when the person was typing unsent text. */
export type SessionShowReply = {
  placement: SessionShowPlacement
  keptKeyboardFocus: boolean
}

export type SessionShowResult = {
  shown: boolean
  mode: SessionShowMode
  placement: SessionShowPlacement | null
  keptKeyboardFocus: boolean
  target: { paneKey: string | null; tabId: string | null; title: string; worktreeId: string } | null
  summary: string
}

const PLACEMENTS: readonly string[] = [
  'split',
  'grid',
  'grid-replaced',
  'already-shown',
  'replaced'
]

/** An older window answers a request it does not know with nothing. */
export function isSessionShowReply(value: unknown): value is SessionShowReply {
  if (!value || typeof value !== 'object') {
    return false
  }
  const reply = value as Record<string, unknown>
  return (
    typeof reply.placement === 'string' &&
    PLACEMENTS.includes(reply.placement) &&
    typeof reply.keptKeyboardFocus === 'boolean'
  )
}
