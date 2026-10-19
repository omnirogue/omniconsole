import { useEffect, useRef, useState } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { attachSessionToJira } from '@/lib/attach-jira-session'
import {
  jiraSessionTaskId,
  type JiraSessionTask
} from '../../../../shared/console-jira-session-contract'
import { useJiraAttachTasks } from './use-jira-attach-tasks'

/** Selecting an existing issue changes only the session's optional shared Jira reference. */
export function AttachToTaskDialog({
  session,
  open: openOverride,
  onOpenChange,
  onAttached,
  onSelect
}: {
  session: SidebarSession | null
  /** Opens with no session, for a caller that saves the pick itself (`onSelect`), as a project does. */
  open?: boolean
  onOpenChange: (open: boolean) => void
  onAttached?: (taskId: string) => void
  onSelect?: (task: JiraSessionTask) => Promise<boolean>
}): React.JSX.Element {
  const open = openOverride ?? session !== null
  const scope = useAppStore(selectConsoleAccountScope)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState<'APU' | 'OMR' | 'SWAYB'>('APU')
  const [division, setDivision] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef({ active: true })
  const inFlight = useRef(false)
  const sourceKey = session ? sidebarSessionSourceIdentity(session)?.sourceKey : null
  useEffect(() => {
    const current = { active: true }
    generation.current = current
    setQuery('')
    setError('')
    setBusy(false)
    inFlight.current = false
    return () => {
      current.active = false
    }
  }, [open, scope, sourceKey, session?.hostId, session?.sessionKey])
  const work = useJiraAttachTasks(open, scope, query, project)
  useEffect(() => {
    if (work.config?.projects.length && !work.config.projects.some((row) => row.key === project)) {
      setProject(work.config.projects[0]!.key)
    }
  }, [project, work.config])
  const select = async (task: JiraSessionTask) => {
    if ((!session && !onSelect) || inFlight.current) {
      return
    }
    const token = generation.current
    const current = () =>
      token.active &&
      token === generation.current &&
      selectConsoleAccountScope(useAppStore.getState()) === scope
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      if (onSelect) {
        const accepted = await onSelect(task)
        if (current() && accepted) {
          onOpenChange(false)
        }
        return
      }
      if (!session) {
        return
      }
      const result = await attachSessionToJira(session, task)
      if (!current()) {
        return
      }
      if (result.contextWarning) {
        toast.warning(result.contextWarning)
      } else {
        toast.success(
          translate('tasks.jira.attached', 'Attached to {{key}}', { key: task.work_ref.issue_key })
        )
      }
      onAttached?.(jiraSessionTaskId(task.work_ref))
      onOpenChange(false)
    } catch (reason) {
      if (current()) {
        setError(
          reason instanceof Error ? reason.message : 'The Jira link could not be saved. Try again.'
        )
      }
    } finally {
      if (current()) {
        setBusy(false)
        inFlight.current = false
      }
    }
  }
  const issues = work.issues.filter((task) => !division || task.division.name === division)
  return (
    <Dialog open={open} onOpenChange={(open) => !inFlight.current && onOpenChange(open)}>
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Link2 className="size-4" />
            {translate('tasks.jira.title', 'Add to a Jira task')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'tasks.jira.attachDescription',
              'Attach to an existing task. Sessions can stay taskless; this does not create a task or change sharing.'
            )}
          </DialogDescription>
        </DialogHeader>
        {work.config && !work.config.enabled && (
          <p role="status" className="text-xs">
            {translate('tasks.jira.disabled', 'Jira tasks are not enabled on this console.')}
          </p>
        )}
        <div className="flex gap-2">
          <select
            aria-label={translate('tasks.jira.company', 'Company')}
            value={project}
            onChange={(event) => setProject(event.target.value as typeof project)}
            className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {(work.config?.projects ?? []).map((row) => (
              <option key={row.key} value={row.key}>
                {row.key}
              </option>
            ))}
          </select>
          <select
            aria-label={translate('tasks.jira.division', 'Division')}
            value={division}
            onChange={(event) => setDivision(event.target.value)}
            className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="">{translate('tasks.jira.allDivisions', 'All divisions')}</option>
            {['Sales', 'Operations', 'Finance/Admin', 'Customer Service'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
        <Input
          aria-label={translate('tasks.jira.find', 'Find a Jira task')}
          placeholder={translate('tasks.jira.searchPlaceholder', 'Search title or issue key')}
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        {work.config && !work.config.connection.connected && (
          <p role="status" className="text-xs">
            {work.config.connection.detail ??
              translate(
                'tasks.jira.connectOwn',
                'Connect your own Jira account in the shared console.'
              )}
          </p>
        )}
        <div
          className="scrollbar-sleek max-h-[45vh] space-y-1 overflow-y-auto"
          data-attach-task-list
        >
          {issues.map((task) => (
            <Button
              key={task.work_ref.issue_id}
              variant="ghost"
              className="h-auto w-full justify-start whitespace-normal text-left text-xs"
              disabled={busy || work.loading}
              onClick={() => void select(task)}
              data-attach-task={task.work_ref.issue_key}
            >
              <span>
                <span className="block">
                  {task.work_ref.issue_key} · {task.summary}
                </span>
                <span className="text-muted-foreground">
                  {task.division.name ?? translate('tasks.jira.noDivision', 'No division')} ·{' '}
                  {task.status.name}
                </span>
              </span>
            </Button>
          ))}
          {work.loading && (
            <p role="status" className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3 animate-spin" />
              {translate('tasks.jira.loading', 'Reading Jira tasks…')}
            </p>
          )}
          {!work.loading && work.config?.connection.connected && !issues.length && !work.error && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'tasks.jira.noLoadedMatches',
                'No matches in the loaded pages. Use search or load more tasks.'
              )}
            </p>
          )}
        </div>
        {work.cursor && (
          <Button variant="outline" disabled={busy || work.loading} onClick={work.loadMore}>
            {translate('tasks.jira.loadMore', 'Load more tasks')}
          </Button>
        )}
        {(error || work.error) && (
          <p role="alert" className="text-xs text-destructive">
            {error || work.error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={work.retry}>
            {translate('tasks.jira.refresh', 'Refresh')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void window.api.shell.openUrl('https://console.example.com/work/jira')}
          >
            {translate('tasks.jira.openShared', 'Open shared Jira tasks')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
