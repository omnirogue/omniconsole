import { translate } from '@/i18n/i18n'
import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { AttachToTaskDialog } from '@/components/tasks/AttachToTaskDialog'
import { attachSessionToJira } from '@/lib/attach-jira-session'
import { Button } from '@/components/ui/button'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useAppStore } from '@/store'
import type { JiraSessionTask } from '../../../../../shared/console-jira-session-contract'
import type { SessionBulkItem } from './SessionBulkNextStep'
import { runSessionBulkAction, type SessionBulkOutcome } from './session-bulk-outcome'

export function attachableSessionItems(items: readonly SessionBulkItem[]): SessionBulkItem[] {
  return items.filter((item) => sidebarSessionSourceIdentity(item.session) !== null)
}

/** A refused write never leaves a local-only task link. Each session keeps its own receipt. */
export async function attachSessionsToTask(
  items: readonly SessionBulkItem[],
  task: JiraSessionTask,
  expectedScope?: string
): Promise<SessionBulkOutcome[]> {
  const accountScope = expectedScope ?? selectConsoleAccountScope(useAppStore.getState())
  return runSessionBulkAction(items, async (item) => {
    if (selectConsoleAccountScope(useAppStore.getState()) !== accountScope) {
      return {
        ok: false,
        message: translate('tasks.jira.accountChanged', 'The account changed — not linked.')
      }
    }
    const result = await attachSessionToJira(item.session, task)
    return { ok: true, ...(result.contextWarning ? { message: result.contextWarning } : {}) }
  })
}

export function SessionBulkAttachToTask({
  items,
  disabled,
  onFinished
}: {
  items: readonly SessionBulkItem[]
  disabled: boolean
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}): React.JSX.Element {
  const attachable = attachableSessionItems(items)
  const scope = useAppStore(selectConsoleAccountScope)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="gap-1"
        disabled={disabled || !attachable.length}
        data-session-bulk-action="add-to-task"
        onClick={() => setOpen(true)}
      >
        <Link2 className="size-3" />
        {translate('tasks.jira.bulkAttach', 'Add to Jira task ({{count}})', {
          count: attachable.length
        })}
      </Button>
      <AttachToTaskDialog
        session={open ? (attachable[0]?.session ?? null) : null}
        onOpenChange={setOpen}
        onSelect={async (task) => {
          const results = await attachSessionsToTask(attachable, task, scope)
          if (selectConsoleAccountScope(useAppStore.getState()) !== scope) {
            return false
          }
          onFinished(results)
          return true
        }}
      />
    </>
  )
}
