// One rule for every move path (session parity, Phase 1b, E1 for filing): a row its paired owner
// places is filed on that owner — the tree reads the owner's folder first (sessionRowFolderId) —
// so a membership written here could never show, and no owner route for moves ships before
// Phase 2b. Row drags, batch drags, bulk "Move to folder", "Remove from Saved Sessions", project
// drops and the CLI relay all pass their keys through here, so the refusal is said once, the
// same way E1 says it, and the rest of the batch still moves.

import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { conversationViewKey } from './conversation-view'
import { isOwnerPlacedRow, ownerPlacedRowRefusal } from './mirrored-conversation-row-actions'
import type { SidebarSession } from './sidebar-session-types'
import { buildPaneSessions } from './sidebar-sessions'

/** The bulk items a move may file: rows with a key that no paired owner places. */
export function movableBulkItems<
  T extends { session: Pick<SidebarSession, 'sessionKey' | 'rowKey' | 'mirroredConversation'> }
>(items: readonly T[]): T[] {
  return items.filter((item) => item.session.sessionKey && !isOwnerPlacedRow(item.session))
}

/** The keys of `keys` that may be filed here, after telling the person where the others are filed. */
export function movableSessionKeys(keys: readonly string[]): string[] {
  if (keys.length === 0) {
    return []
  }
  let refusals: Map<string, string>
  try {
    const wanted = new Set(keys)
    refusals = new Map(
      buildPaneSessions(useAppStore.getState()).flatMap((session) => {
        const key = conversationViewKey(session)
        const refusal =
          wanted.has(key) && isOwnerPlacedRow(session) ? ownerPlacedRowRefusal(session) : null
        return refusal ? [[key, refusal] as const] : []
      })
    )
  } catch {
    // Why: a store this window cannot read rows from (tests, early startup) refuses nothing.
    return [...keys]
  }
  if (refusals.size === 0) {
    return [...keys]
  }
  // Why once per computer: the same words as the row's own disabled Move, not one toast per row.
  for (const refusal of new Set(refusals.values())) {
    toast.error(refusal)
  }
  return keys.filter((key) => !refusals.has(key))
}
