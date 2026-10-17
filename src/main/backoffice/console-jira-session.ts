import { createHash } from 'node:crypto'
import { z } from 'zod'
import { consoleJiraWorkRef } from '../../shared/console-jira-work-contract'
import {
  jiraSessionAttach,
  jiraSessionSource,
  jiraSessionTask,
  jiraSessionTaskId,
  jiraSessionTasks,
  jiraTaskSearch,
  jiraSessionConfig
} from '../../shared/console-jira-session-contract'
import type {
  ConsoleSessionAttachResult,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { failure, validated, requestConsoleWorkflow as request } from './console-workflow-transport'

// Full editable summary, never the compact /now projection. The server owns revisions and grants.
export const consoleSessionSummary = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  visibility: z.enum(['private', 'company']),
  company_key: z.string().nullable(),
  division: z.string().nullable(),
  purpose: z.string(),
  progress: z.string(),
  next_action: z.string(),
  responsible_actor: z.string(),
  work_ref: consoleJiraWorkRef.nullable(),
  parent_ledger_id: z.string().nullable(),
  outcome_refs: z.array(z.string()),
  handoff_refs: z.array(z.string())
})
export const consoleSessionRow = z.object({
  ledger_id: z.string(),
  app: z.literal('omni-ide'),
  work_summary: consoleSessionSummary.nullable().optional()
})
export const consoleSessionDetail = z.object({ session: consoleSessionRow })

async function sourceContext(sourceKey: string) {
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  const source = ledgerSourceForSession(sourceKey, person.data.principal)
  if (!source) {
    return failure<never>(
      'binding_changed',
      'This conversation has no saved session identity for the signed-in account.'
    )
  }
  const isCurrent = () =>
    person.data.isCurrent() &&
    JSON.stringify(ledgerSourceForSession(sourceKey, person.data.principal)) ===
      JSON.stringify(source)
  const read = () =>
    request(
      `/api/sessions/${source.ledgerId}`,
      'GET',
      consoleSessionDetail,
      undefined,
      15_000,
      false,
      person.data.principal,
      isCurrent
    )
  return { ok: true as const, data: { ...person.data, source, isCurrent, read } }
}

export const listJiraSessionTasks = (args: z.infer<typeof jiraTaskSearch>) =>
  validated(args, jiraTaskSearch, ({ projectKey, query, cursor }) => {
    const params = new URLSearchParams({ project_key: projectKey })
    if (query) {
      params.set('q', query)
    }
    if (cursor) {
      params.set('cursor', cursor)
    }
    return request(`/api/jira-tasks/issues?${params}`, 'GET', jiraSessionTasks)
  })

export const readJiraSessionConfig = () =>
  request('/api/jira-tasks/config', 'GET', jiraSessionConfig)

/** Read-only discovery and refresh; no enrollment, task creation or execution mutation. */
export function readJiraSessionTask(
  args: z.infer<typeof jiraSessionSource>
): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>> {
  return validated(args, jiraSessionSource, async ({ sourceKey }) => {
    const captured = await sourceContext(sourceKey)
    if (!captured.ok) {
      return captured
    }
    const { source, read, principal, isCurrent } = captured.data
    const before = await read()
    if (!before.ok) {
      return before
    }
    if (before.data.session.ledger_id !== source.ledgerId) {
      return failure('binding_changed', 'The session changed.')
    }
    const work = before.data.session.work_summary
    if (!work?.work_ref) {
      return { ok: true, data: { ok: true, sessionId: source.ledgerId } }
    }
    const task = await request(
      `/api/jira-tasks/issues/${work.work_ref.issue_id}`,
      'GET',
      jiraSessionTask,
      undefined,
      15_000,
      false,
      principal,
      isCurrent
    )
    if (!task.ok) {
      return task
    }
    const after = await read()
    if (!after.ok) {
      return after
    }
    if (
      !isCurrent() ||
      after.data.session.ledger_id !== source.ledgerId ||
      JSON.stringify(after.data.session.work_summary) !== JSON.stringify(work) ||
      JSON.stringify(task.data.work_ref) !== JSON.stringify(work.work_ref)
    ) {
      return failure(
        'binding_changed',
        'The session or Jira reference changed. Refresh before continuing.'
      )
    }
    const taskId = jiraSessionTaskId(work.work_ref)
    const context = JSON.stringify({ task: task.data, session: work })
    if (Buffer.byteLength(context, 'utf8') > 48_000) {
      return failure(
        'context_unavailable',
        'This Jira context is too large. Open the issue to read it.'
      )
    }
    return {
      ok: true,
      data: {
        ok: true,
        sessionId: source.ledgerId,
        taskId,
        workRef: work.work_ref,
        title: task.data.summary,
        context: {
          card_id: taskId,
          work_ref: work.work_ref,
          state_revision: work.revision,
          available: true,
          status: 'ready',
          context,
          warnings: [],
          scope: null,
          pack_version: createHash('sha256').update(context).digest('hex'),
          replies_waiting: [],
          dropped_blocks: []
        }
      }
    }
  })
}

/** Change only the existing ledger summary's reference, preserving visibility and other work. */
export function attachJiraSession(
  args: z.infer<typeof jiraSessionAttach>
): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>> {
  return validated(args, jiraSessionAttach, async ({ sourceKey, workRef }) => {
    const captured = await sourceContext(sourceKey)
    if (!captured.ok) {
      return captured
    }
    const { source, principal, isCurrent, read } = captured.data
    const before = await read()
    if (!before.ok) {
      return before
    }
    if (before.data.session.ledger_id !== source.ledgerId) {
      return failure('binding_changed', 'The session changed.')
    }
    const old = before.data.session.work_summary
    if (old?.company_key && old.company_key !== workRef.project_key) {
      return failure(
        'company_mismatch',
        'Choose a Jira task in this session’s company. Change its company in the shared session view first.'
      )
    }
    const { revision, ...fields } = old ?? {
      version: 1 as const,
      revision: 0,
      visibility: 'private' as const,
      company_key: null,
      division: null,
      purpose: '',
      progress: '',
      next_action: '',
      responsible_actor: '',
      work_ref: null,
      parent_ledger_id: null,
      outcome_refs: [],
      handoff_refs: []
    }
    const saved = await request(
      `/api/agent-sessions/${source.ledgerId}/register`,
      'POST',
      z.object({ ok: z.literal(true), row: consoleSessionRow }),
      {
        work_summary: {
          ...fields,
          expected_revision: revision,
          company_key: workRef.project_key,
          work_ref: workRef
        }
      },
      30_000,
      false,
      principal,
      isCurrent
    )
    if (!saved.ok) {
      return saved
    }
    if (
      !isCurrent() ||
      saved.data.row.ledger_id !== source.ledgerId ||
      JSON.stringify(saved.data.row.work_summary?.work_ref) !== JSON.stringify(workRef)
    ) {
      return failure(
        'binding_changed',
        'The session link was not confirmed. Refresh before retrying.'
      )
    }
    const refreshed = await readJiraSessionTask({ sourceKey })
    if (refreshed.ok && refreshed.data.taskId === jiraSessionTaskId(workRef) && isCurrent()) {
      return refreshed
    }
    if (
      !isCurrent() ||
      (refreshed.ok && refreshed.data.taskId !== jiraSessionTaskId(workRef)) ||
      (!refreshed.ok && refreshed.error.code === 'binding_changed')
    ) {
      return failure('binding_changed', 'The conversation changed while linking its task.')
    }
    return {
      ok: true,
      data: {
        ok: true,
        sessionId: source.ledgerId,
        taskId: jiraSessionTaskId(workRef),
        workRef,
        contextWarning:
          'The Jira link was saved, but current task context is unavailable. Refresh before sending an agent update.'
      }
    }
  })
}
