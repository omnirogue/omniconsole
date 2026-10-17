import type { AttentionPane } from './agent-pane-snapshot'
import { clampAttentionCursor } from './attention-slot'

/** The pane key `delta` steps away from `index` among the panes waiting on the user. */
export function stepAttentionPane(
  candidates: readonly AttentionPane[],
  index: number,
  delta: number
): string | null {
  if (candidates.length === 0) {
    return null
  }
  return (
    candidates[clampAttentionCursor(Math.max(index, 0) + delta, candidates.length)]?.paneKey ?? null
  )
}
