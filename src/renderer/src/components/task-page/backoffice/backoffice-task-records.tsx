import { BackofficeTaskConversationList } from './backoffice-task-conversations'
import { BackofficeTaskOutcomes } from './backoffice-task-outcomes'
import { BackofficeSessionLink } from './backoffice-session-link'
import { TaskDrivePanel } from '@/components/task-drive/TaskDrivePanel'
import { translate } from '@/i18n/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { handoffApi } from '@/components/handoffs/handoff-client'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { WorkSessions } from '../../../../../shared/console-work-home-contract'

export function BackofficeTaskConversations({ taskId }: { taskId: string }) {
  return (
    <>
      <BackofficeTaskOutcomes taskId={taskId} />
      <BackofficeTaskConversationList taskId={taskId} />
    </>
  )
}

export function BackofficeTaskFiles({
  taskId,
  baseUrl,
  refreshKey = 0
}: {
  taskId: string
  baseUrl: string | null
  refreshKey?: number
}) {
  const [files, setFiles] = useState<{ rel: string; size: number; sha256: string | null }[] | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    void Promise.resolve()
      .then(() => handoffApi().taskFiles({ taskId }))
      .then((result) => {
        const value = workflowData(result)
        if (!disposed) {
          setFiles(value.files)
          setError(null)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(workflowErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [taskId, refreshKey])
  return (
    <section
      className="space-y-2"
      aria-label={translate('unifiedWork.669de3726a2f', 'Artifacts and revisions')}
    >
      <h3 className="text-sm font-semibold">
        {translate('unifiedWork.669de3726a2f', 'Artifacts and revisions')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'unifiedWork.55bd5fdd0dff',
          'Reviews in the handoff bind to its exact file version. Changed candidates need a fresh review.'
        )}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.556d01ce9aa7', 'Files unavailable:')}
          {error}
        </p>
      )}
      {files && !files.length && (
        <p className="text-xs text-muted-foreground">
          {translate('unifiedWork.e1d403221091', 'No files returned.')}
        </p>
      )}
      <ul className="space-y-2">
        {files?.map((file) => (
          <li key={file.rel} className="rounded-md border border-border p-2 text-xs">
            <p>
              {file.rel} · {file.size}
              {translate('unifiedWork.277089d91c0b', 'bytes')}
            </p>
            <p className="break-all font-mono">
              {translate('unifiedWork.cd454382899a', 'SHA-256:')}
              {file.sha256 ?? translate('unifiedWork.adadface0166', 'Not reported')}
            </p>
            {baseUrl && (
              <a
                className="underline"
                target="_blank"
                rel="noreferrer"
                href={`${baseUrl}/api/board/${encodeURIComponent(taskId)}/files/download?path=${encodeURIComponent(file.rel)}`}
              >
                {/checklist/i.test(file.rel)
                  ? translate('unifiedWork.a77c7b510d43', 'Open checklist')
                  : translate('unifiedWork.9de4149fb971', 'Download file')}
              </a>
            )}
          </li>
        ))}
      </ul>
      <TaskDrivePanel taskId={taskId} />
    </section>
  )
}
export function BackofficeTaskSessions({
  taskId,
  baseUrl
}: {
  taskId: string
  baseUrl: string | null
}) {
  const [data, setData] = useState<WorkSessions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unlinked, setUnlinked] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let disposed = false
    void Promise.resolve()
      .then(() => consoleWorkflowApi().listWorkSessions())
      .then((result) => {
        const value = workflowData(result)
        if (!disposed) {
          setData(value)
          setError(null)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setData(null)
          setError(workflowErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [taskId, revision])
  const sessions = (data?.sessions ?? []).filter(
    (session) =>
      (unlinked ? !session.board_task_id : session.board_task_id === taskId) &&
      `${session.id} ${session.task_title} ${session.agent_name}`
        .toLowerCase()
        .includes(query.toLowerCase())
  )
  return (
    <section
      className="space-y-2"
      aria-label={translate('unifiedWork.f383dfdb50a8', 'Task sessions')}
    >
      <h3 className="text-sm font-semibold">{translate('unifiedWork.6fa3cbf451b2', 'Sessions')}</h3>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setUnlinked((value) => !value)
          setPage(0)
        }}
      >
        {unlinked
          ? translate('unifiedWork.linkedSessions', 'Task sessions')
          : translate('unifiedWork.unlinkedSessions', 'Inspect unlinked sessions')}
      </Button>
      <Input
        aria-label={translate('unifiedWork.d3abe2aa71a3', 'Search task sessions')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setPage(0)
        }}
        placeholder={translate('unifiedWork.4eae194f0686', 'Search returned task sessions')}
      />
      <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
        {translate('unifiedWork.8bbcdf8b054d', 'Refresh sessions')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.fd553451b05c', 'Sessions unavailable:')}
          {error}
        </p>
      )}
      {data && (
        <p className="text-xs text-muted-foreground">
          {data.truncated
            ? translate('unifiedWork.cad0a2eb3ed5', 'Partial session feed.')
            : translate(
                'unifiedWork.36328be84efa',
                'Returned session inventory; complete historical coverage is not established.'
              )}{' '}
          {data.hub?.pending ? translate('unifiedWork.98a7eec6ef51', 'Hub refresh pending.') : ''}{' '}
          {data.hub?.age_s != null
            ? translate('unifiedWork.29e847ecd9b6', 'Hub data age: {{value0}} seconds.', {
                value0: Math.round(data.hub.age_s)
              })
            : ''}{' '}
          {translate('unifiedWork.d217df4a6637', 'Search and pages cover these returned records.')}
        </p>
      )}
      {data && !sessions.length && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'unifiedWork.d07c45ef18eb',
            'No matching linked sessions in this feed. This does not establish inactivity.'
          )}
        </p>
      )}
      <ul className="space-y-2">
        {sessions.slice(page * 20, page * 20 + 20).map((session) => (
          <li key={session.id} className="rounded-md border border-border p-2 text-xs">
            <p>{session.task_title ?? session.task_summary ?? session.id}</p>
            <p>
              {session.agent_name ?? translate('unifiedWork.669250b384c3', 'Agent unknown')} ·{' '}
              {session.agent_status ?? translate('unifiedWork.e412d8725d99', 'Status unknown')} ·{' '}
              {session.machine_id ?? translate('unifiedWork.dd27d9d19a07', 'Host unknown')}
            </p>
            <p>
              {translate('unifiedWork.9ba68d06594b', 'Logs: availability checked when opened.')}
            </p>
            {baseUrl && (
              <a
                className="underline"
                target="_blank"
                rel="noreferrer"
                href={`${baseUrl}/sessions/${encodeURIComponent(session.id)}`}
              >
                {translate('unifiedWork.c302085e72e7', 'Open session and logs')}
              </a>
            )}
            {!session.board_task_id && (
              <BackofficeSessionLink
                sessionId={session.id}
                taskId={taskId}
                onLinked={() => setRevision((value) => value + 1)}
              />
            )}
            <p className="font-mono">
              {session.board_task_id
                ? `${translate('unifiedWork.4bc74b21357c', 'Task')} ${session.board_task_id}`
                : translate('unifiedWork.noTaskLink', 'Not linked to a task')}
              {session.job_id
                ? translate('unifiedWork.cad42398e0b1', ' · Attempt job {{value0}}', {
                    value0: session.job_id
                  })
                : ''}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => setPage((value) => value - 1)}
        >
          {translate('unifiedWork.a57b08a480b8', 'Previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={(page + 1) * 20 >= sessions.length}
          onClick={() => setPage((value) => value + 1)}
        >
          {translate('unifiedWork.c08ac736a5e2', 'Next page')}
        </Button>
      </div>
      {baseUrl && (
        <a
          className="text-xs underline"
          target="_blank"
          rel="noreferrer"
          href={`${baseUrl}/sessions`}
        >
          {translate(
            'unifiedWork.5058710c782d',
            'Open authorized session inventory to inspect unlinked records'
          )}
        </a>
      )}
    </section>
  )
}
