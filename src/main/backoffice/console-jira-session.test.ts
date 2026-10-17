import { beforeEach, expect, it, vi } from 'vitest'
import {
  attachJiraSession,
  listJiraSessionTasks,
  readJiraSessionTask
} from './console-jira-session'
import { jiraSessionTaskId } from '../../shared/console-jira-session-contract'
const mocks = vi.hoisted(() => ({ current: true, source: true }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      baseUrl: 'https://console.test',
      bearer: 'fixture',
      principal: 'person',
      isCurrent: () => mocks.current
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
vi.mock('../session-ledger/ledger-lookup', () => ({
  ledgerSourceForSession: () =>
    mocks.source ? { ledgerId: 'als_0123456789abcdef01234567', account: 'person' } : null
}))
const fetchMock = vi.fn<typeof fetch>()
const ref = {
  provider: 'jira' as const,
  cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
  issue_id: '10001',
  issue_key: 'APU-1',
  project_key: 'APU'
}
const work = {
  version: 1,
  revision: 7,
  visibility: 'private',
  company_key: 'APU',
  division: 'Operations',
  purpose: 'Keep purpose',
  progress: 'Keep progress',
  next_action: 'Keep next',
  responsible_actor: 'Sal',
  work_ref: ref,
  parent_ledger_id: null,
  outcome_refs: ['outcome_1'],
  handoff_refs: ['handoff_1']
}
const row = { ledger_id: 'als_0123456789abcdef01234567', app: 'omni-ide', work_summary: work }
const task = {
  work_ref: ref,
  summary: 'An existing commitment',
  description_adf: null,
  status: { name: 'Ready' },
  column: 'Ready',
  division: { name: 'Operations', source_label: 'Operations' },
  assignee: null,
  priority: null,
  due_date: null,
  updated: '2026-09-19T23:00:00Z'
}
function reply(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
beforeEach(() => {
  mocks.current = true
  mocks.source = true
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
it('preserves native summary fields and privacy, saves revision-checked reference, then reads current context', async () => {
  reply({ session: { ...row, work_summary: { ...work, work_ref: null } } })
  reply({ ok: true, row: { ...row, work_summary: { ...work, revision: 8 } } })
  reply({ session: { ...row, work_summary: { ...work, revision: 8 } } })
  reply(task)
  reply({ session: { ...row, work_summary: { ...work, revision: 8 } } })
  const result = await attachJiraSession({ sourceKey: 'tab:leaf', workRef: ref })
  expect(result).toMatchObject({
    ok: true,
    data: {
      taskId: jiraSessionTaskId(ref),
      workRef: ref,
      context: { work_ref: ref, state_revision: 8 }
    }
  })
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(String(write[0])).toBe(
    'https://console.test/api/agent-sessions/als_0123456789abcdef01234567/register'
  )
  const { revision: _revision, ...fields } = work
  expect(JSON.parse(String(write[1]?.body))).toEqual({
    work_summary: { ...fields, expected_revision: 7 }
  })
  expect(
    fetchMock.mock.calls.every(
      ([url]) => !String(url).includes('/hub/') && !String(url).includes('/admissions')
    )
  ).toBe(true)
})
it('does not enroll or read Jira for a taskless session', async () => {
  reply({ session: { ...row, work_summary: null } })
  expect(await readJiraSessionTask({ sourceKey: 'pane' })).toEqual({
    ok: true,
    data: { ok: true, sessionId: row.ledger_id }
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
it('refuses cross-company links before writing and reports server revision conflicts', async () => {
  reply({ session: { ...row, work_summary: { ...work, company_key: 'OMR' } } })
  expect(await attachJiraSession({ sourceKey: 'pane', workRef: ref })).toMatchObject({
    ok: false,
    error: { code: 'company_mismatch' }
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  reply({ session: row })
  reply({ tag: 'work-summary-conflict', detail: 'Reload first' }, 409)
  expect(await attachJiraSession({ sourceKey: 'pane', workRef: ref })).toMatchObject({
    ok: false,
    error: { code: 'work-summary-conflict' }
  })
})
it('refuses missing ownership and rejects a binding changed while Jira was read', async () => {
  mocks.source = false
  expect(await readJiraSessionTask({ sourceKey: 'pane' })).toMatchObject({ ok: false })
  expect(fetchMock).not.toHaveBeenCalled()
  mocks.source = true
  reply({ session: row })
  reply(task)
  reply({ session: { ...row, work_summary: { ...work, work_ref: null, revision: 8 } } })
  expect(await readJiraSessionTask({ sourceKey: 'pane' })).toMatchObject({
    ok: false,
    error: { code: 'binding_changed' }
  })
})
it('bounds and encodes search and refuses a switched person', async () => {
  reply({ issues: [task], is_last: false, next_cursor: 'next&token' })
  expect(
    await listJiraSessionTasks({ projectKey: 'APU', query: 'A & B', cursor: 'cursor&1' })
  ).toMatchObject({ ok: true })
  expect(String(fetchMock.mock.calls[0]![0])).toBe(
    'https://console.test/api/jira-tasks/issues?project_key=APU&q=A+%26+B&cursor=cursor%261'
  )
  mocks.current = false
  expect(await readJiraSessionTask({ sourceKey: 'pane' })).toMatchObject({ ok: false })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('does not report a saved link that was concurrently removed before context readback', async () => {
  reply({ session: { ...row, work_summary: null } })
  reply({ ok: true, row })
  reply({ session: { ...row, work_summary: { ...work, work_ref: null, revision: 8 } } })
  expect(await attachJiraSession({ sourceKey: 'pane', workRef: ref })).toMatchObject({
    ok: false,
    error: { code: 'binding_changed' }
  })
})
