import { useEffect, useRef } from 'react'
import { sessionTaskRef } from '@/lib/session-task-sidebar-groups'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionTasks } from '@/store/session-task-store'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import { linkNextStepTask } from './next-steps-client'

const NO_LEDGER_CARDS: ReadonlyMap<string, string> = new Map()

/**
 * Tells the host which hub card this conversation serves, so JEV reads its doneness against the
 * card's goal. Advisory: an older host without the method, or any failure, changes nothing.
 */
export function useNextStepTaskLink(
  session: SidebarSession | null | undefined,
  conversation: ConversationSource | null
): void {
  const links = useSessionTasks((state) => state.links)
  const loaded = useSessionTasks((state) => state.loaded)
  // What this surface last told the host per conversation, and which attempt told it; each mount
  // tells it once (a restarted host forgets).
  const sent = useRef(new Map<string, { taskId: string | null; attempt: number }>())
  const attempts = useRef(0)
  useEffect(() => {
    if (!loaded) {
      useSessionTasks.getState().load()
    }
  }, [loaded])
  const taskId = session ? (sessionTaskRef(session, links, NO_LEDGER_CARDS)?.taskId ?? null) : null
  // Why a string: the address object is re-made on every render.
  const address = conversation ? JSON.stringify(conversation) : null
  useEffect(() => {
    if (!address || !loaded) {
      return
    }
    const addressed = JSON.parse(address) as ConversationSource
    const key = conversationSourceRowKey(addressed)
    // Nothing to say about a conversation that was never linked here.
    if ((sent.current.get(key)?.taskId ?? null) === taskId) {
      return
    }
    const attempt = ++attempts.current
    sent.current.set(key, { taskId, attempt })
    linkNextStepTask(addressed, taskId).catch(() => {
      // Only this attempt's record: a later link sent meanwhile, even to the same card, stays told.
      if (sent.current.get(key)?.attempt === attempt) {
        sent.current.delete(key)
      }
    })
  }, [address, loaded, taskId])
}
