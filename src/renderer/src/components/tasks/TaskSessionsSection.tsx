import { useEffect, useState } from 'react'
import { MessageSquare, Monitor } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { paneKeysForTask } from '@/lib/session-task-link'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { useSessionTasks } from '@/store/session-task-store'
import type { ConsoleTaskSession } from '../../../../shared/console-workflow-types'

/**
 * Every session that has worked this task: the ones the hub knows about, and the
 * conversations open on this device. A task holds sessions; it does not become one.
 */
export function TaskSessionsSection({ taskId }: { taskId: string }): React.JSX.Element | null {
  const [hubSessions, setHubSessions] = useState<ConsoleTaskSession[] | null>(null)
  const links = useSessionTasks((state) => state.links)
  const loaded = useSessionTasks((state) => state.loaded)
  const load = useSessionTasks((state) => state.load)
  const sessions = useSidebarSessions()
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [load, loaded])
  useEffect(() => {
    let live = true
    setHubSessions(null)
    const api = window.api?.consoleWorkflows
    if (!api?.taskSessions) {
      return () => {
        live = false
      }
    }
    void api
      .taskSessions({ taskId })
      .then((result) => {
        if (live) {
          setHubSessions(result.ok ? result.data.sessions : [])
        }
      })
      .catch(() => {
        if (live) {
          setHubSessions([])
        }
      })
    return () => {
      live = false
    }
  }, [taskId])
  const paneKeys = new Set(paneKeysForTask(links, taskId))
  const local = sessions.filter((session) => {
    const source = sidebarSessionSourceIdentity(session)
    return source !== null && paneKeys.has(source.sourceKey)
  })
  const localHubIds = new Set(
    local.map((session) => links[sidebarSessionSourceIdentity(session)!.sourceKey]?.sessionId)
  )
  const remote = (hubSessions ?? []).filter((session) => !localHubIds.has(session.id))
  if (local.length === 0 && remote.length === 0) {
    return null
  }
  return (
    <section className="space-y-1" data-task-sessions={taskId}>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {translate('tasks.sessions', 'Work on this task')}
      </h4>
      <ul className="space-y-px text-xs">
        {local.map((session) => (
          <li key={session.rowKey}>
            <button
              type="button"
              onClick={() => void activateSidebarSession(session)}
              data-task-session-local={sidebarSessionSourceIdentity(session)?.sourceKey ?? ''}
              className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-accent"
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{session.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {translate('tasks.hereNow', 'here')}
              </span>
            </button>
          </li>
        ))}
        {remote.map((session) => (
          <li
            key={session.id}
            data-task-session={session.id}
            className="flex h-7 items-center gap-1.5 px-1"
          >
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {session.title ?? translate('tasks.aSession', 'A session')}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {[session.state, session.machineId].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
