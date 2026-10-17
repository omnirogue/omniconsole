import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useBackofficeWorkViews } from '@/components/task-page/backoffice/backoffice-work-store'
import { valueOf } from '@/components/task-page/backoffice/backoffice-work-reads'
import { useInboxReadState } from './inbox-read-state'

/** Sidebar and tabs share Work's account-fenced reads, pagination and refresh loop. */
export function useInboxUnread() {
  const scope = useHandoffScope()
  const { views, reads, loading } = useBackofficeWorkViews(scope, true)
  const viewer =
    valueOf(reads.todo)?.employeeId ??
    valueOf(reads.receivedOpen)?.assignee ??
    valueOf(reads.sent)?.assignee ??
    null
  const readState = useInboxReadState(scope, viewer)
  let messages = 0
  let handoffs = 0
  for (const row of views.all) {
    if (readState.isUnread(row)) {
      if (row.message) {
        messages += 1
      }
      if (row.thread) {
        handoffs += 1
      }
    }
  }
  return { messages, handoffs, total: messages + handoffs, loading }
}
