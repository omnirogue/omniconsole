import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useBackofficeWorkViews } from '@/components/task-page/backoffice/backoffice-work-store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionTask } from '@/store/session-task-store'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'

/**
 * The hub card this conversation serves, as Tasks knows it (with its revision), so ✓ on
 * the conversation finishes that card.
 *
 * The conversation's own link wins. The workspace-wide binding older builds wrote is
 * still read so ✓ keeps finishing those cards, but nothing writes it any more: one card
 * per folder made every session in a folder share it and stopped a task spanning folders.
 */
export function useLinkedCardForSession(
  session: Pick<SidebarSession, 'worktreeId' | 'paneKey'> | null
): BackofficeTodoItem | null {
  const sessionLink = useSessionTask(
    session ? (sidebarSessionSourceIdentity(session)?.sourceKey ?? null) : null
  )
  const legacyTaskId = useAppStore((state) =>
    session
      ? (state.getKnownWorktreeById(session.worktreeId)?.linkedWorkItem?.hubTaskId ?? null)
      : null
  )
  const hubTaskId = sessionLink?.workRef ? null : (sessionLink?.taskId ?? legacyTaskId)
  const scope = useHandoffScope()
  const { reads } = useBackofficeWorkViews(scope, hubTaskId !== null)
  const feed =
    reads.todo.phase === 'ready'
      ? reads.todo.value
      : reads.todo.phase === 'loading' || reads.todo.phase === 'error'
        ? reads.todo.previous
        : null
  if (!hubTaskId || !feed) {
    return null
  }
  return feed.items.find((item) => item.task_id === hubTaskId) ?? null
}
