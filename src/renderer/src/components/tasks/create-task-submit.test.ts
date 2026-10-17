// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachSessionToTask, createTaskFromSession, createTaskFromUi } from './create-task-submit'
import { useSessionTasks } from '@/store/session-task-store'
import { useAppStore } from '@/store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { prepareSessionTaskContext } from '@/lib/session-task-context'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const invalidateWork = vi.hoisted(() => vi.fn())
vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  invalidateBackofficeWork: invalidateWork
}))

const createTask = vi.fn()
const ingestSession = vi.fn()
const attachSession = vi.fn()
const linkCard = vi.fn()
const session = { paneKey: 'tab-1:leaf-1', label: 'Simplify handoffs', agent: 'claude' }

beforeEach(() => {
  invalidateWork.mockReset()
  createTask.mockReset()
  ingestSession.mockReset()
  attachSession.mockReset()
  linkCard.mockReset()
  linkCard.mockResolvedValue(true)
  useSessionTasks.setState({ links: {}, loaded: true })
  localStorage.clear()
  Object.assign(window, {
    api: {
      backoffice: { createTask },
      consoleWorkflows: { ingestSession, attachSession },
      sessionLedger: { linkCard }
    }
  })
})

describe('turning a conversation into a task', () => {
  it('creates the card filed, registers the conversation and links the two', async () => {
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Simplify handoffs' })
    ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_abcd1234' } })
    attachSession.mockResolvedValue({ ok: true, data: { ok: true } })
    const outcome = await createTaskFromSession(session, {
      title: '  Simplify handoffs  ',
      companyId: 'co_rogue',
      unitId: 'org_dev',
      goalId: 'cgl_reliability',
      projectId: 'proj_bots',
      actorIds: ['emp_sal', 'emp_uma'],
      ownerEmployeeId: 'emp_sal',
      cwd: '/Users/maintainer/Work/OmniRogue/Development/OmniConsole',
      model: 'opus'
    })
    expect(outcome).toMatchObject({
      ok: true,
      taskId: 'btk_1234abcd',
      title: 'Simplify handoffs',
      sessionId: 'ses_abcd1234',
      attached: true
    })
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Simplify handoffs',
        companyId: 'co_rogue',
        unitId: 'org_dev',
        goalId: 'cgl_reliability',
        projectId: 'proj_bots',
        actorIds: ['emp_sal', 'emp_uma'],
        ownerEmployeeId: 'emp_sal'
      })
    )
    expect(ingestSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRef: 'tab-1:leaf-1', provider: 'claude', model: 'opus' })
    )
    expect(attachSession).toHaveBeenCalledWith({
      sessionId: 'ses_abcd1234',
      taskId: 'btk_1234abcd'
    })
    expect(useSessionTasks.getState().links['tab-1:leaf-1']).toMatchObject({
      taskId: 'btk_1234abcd',
      sessionId: 'ses_abcd1234'
    })
  })

  it('attaches an actual structured conversation with no terminal pane', async () => {
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Plan' })
    ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_native1234' } })
    attachSession.mockResolvedValue({ ok: true, data: { ok: true } })
    const native = {
      kind: 'structured' as const,
      paneKey: null,
      tabId: 'structured-agent-session-codex_b7796179_e75c_44c3_bb57_c9020551ec83',
      label: 'Planning',
      agent: 'codex'
    }
    const outcome = await createTaskFromSession(native, { title: 'Plan' })
    expect(outcome).toMatchObject({ attached: true, sessionId: 'ses_native1234' })
    expect(ingestSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRef: 'codex_b7796179_e75c_44c3_bb57_c9020551ec83' })
    )
    const key = Object.keys(useSessionTasks.getState().links)[0]!
    expect(key).toMatch(/^structured-agent-session-codex_b7796179.*:/)
    expect(useSessionTasks.getState().links[key]).toMatchObject({
      taskId: 'btk_1234abcd',
      sessionId: 'ses_native1234'
    })
  })

  it('refuses a task with no name and never calls the server', async () => {
    expect(await createTaskFromSession(session, { title: '   ' })).toEqual({
      ok: false,
      message: 'A task needs a name before it can be tracked.'
    })
    expect(createTask).not.toHaveBeenCalled()
  })

  it('keeps the task when the link fails, and reports that the link is missing', async () => {
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Simplify handoffs' })
    ingestSession.mockResolvedValue({ ok: false, error: { code: 'x', message: 'no' } })
    const outcome = await createTaskFromSession(session, { title: 'Simplify handoffs' })
    expect(outcome).toMatchObject({ ok: true, taskId: 'btk_1234abcd', attached: false })
    expect(attachSession).not.toHaveBeenCalled()
    // The conversation still remembers its task, so the row shows it at once.
    expect(useSessionTasks.getState().links['tab-1:leaf-1']).toMatchObject({
      taskId: 'btk_1234abcd'
    })
  })

  it('passes the card refusal through untouched', async () => {
    createTask.mockResolvedValue({ ok: false, message: 'The backoffice refused the new task.' })
    expect(await createTaskFromSession(session, { title: 'Simplify handoffs' })).toEqual({
      ok: false,
      message: 'The backoffice refused the new task.'
    })
    expect(ingestSession).not.toHaveBeenCalled()
  })

  it('joins a later conversation to the same task', async () => {
    ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_efgh5678' } })
    attachSession.mockResolvedValue({ ok: true, data: { ok: true } })
    const second = { paneKey: 'tab-2:leaf-1', label: 'Verify on Windows', agent: 'codex' }
    expect(await attachSessionToTask(second, 'btk_1234abcd', { cwd: '/tmp/x' })).toMatchObject({
      sessionId: 'ses_efgh5678',
      attached: true
    })
    expect(ingestSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRef: 'tab-2:leaf-1', provider: 'codex' })
    )
  })

  it('does not inject memory after a refused attachment, even if a task is remembered for display', async () => {
    useAppStore.setState({
      activeOrcaProfileId: 'person-a',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        workspace: [
          {
            id: 'structured-agent-session-context-1',
            entityId: 'context-1',
            contentType: 'agent-session',
            executionHostId: 'local',
            agentSessionAgent: 'codex',
            label: 'Plan'
          }
        ]
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    } as never)
    const source = buildSidebarSessions(useAppStore.getState())[0]!
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Plan' })
    ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_native1234' } })
    attachSession.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Not permitted' }
    })
    expect(await createTaskFromSession(source, { title: 'Plan' })).toMatchObject({
      attached: false
    })
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    expect(useSessionTasks.getState().links[key]?.taskId).toBe('btk_1234abcd')
    expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
  })

  it('writes the task onto the conversation’s session-ledger row, hub session or not', async () => {
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Simplify handoffs' })
    // Why: the live hub keeps no ledger copy of an IDE pane, so ingest honestly has no session.
    ingestSession.mockResolvedValue({
      ok: false,
      error: { code: 'hub_session_unavailable', message: 'no hub session' }
    })
    const outcome = await createTaskFromSession(session, { title: '  Simplify handoffs  ' })
    expect(outcome).toMatchObject({ ok: true, attached: false, ledgerLinked: true })
    expect(attachSession).not.toHaveBeenCalled()
    expect(linkCard).toHaveBeenCalledWith('tab-1:leaf-1', {
      cardId: 'btk_1234abcd',
      cardTitle: 'Simplify handoffs'
    })
  })

  it('links the ledger row of a structured conversation under its pane key', async () => {
    ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_efgh5678' } })
    attachSession.mockResolvedValue({ ok: true, data: { ok: true } })
    const native = {
      kind: 'structured' as const,
      paneKey: null,
      tabId: 'structured-agent-session-codex_b7796179_e75c_44c3_bb57_c9020551ec83',
      label: 'Planning',
      agent: 'codex'
    }
    const outcome = await attachSessionToTask(native, 'btk_1234abcd', { title: 'Plan' })
    expect(outcome).toMatchObject({ attached: true, ledgerLinked: true })
    expect(linkCard).toHaveBeenCalledWith(sidebarSessionSourceIdentity(native)!.sourceKey, {
      cardId: 'btk_1234abcd',
      cardTitle: 'Plan'
    })
  })

  it('reports no ledger link when this desktop holds no row for the conversation', async () => {
    linkCard.mockResolvedValue(false)
    ingestSession.mockResolvedValue({ ok: false, error: { code: 'x', message: 'no' } })
    expect(await attachSessionToTask(session, 'btk_1234abcd')).toMatchObject({
      attached: false,
      ledgerLinked: false
    })
  })

  it('does not attach under a replacement account after ingest', async () => {
    useAppStore.setState({ activeOrcaProfileId: 'person-a' })
    ingestSession.mockImplementation(async () => {
      useAppStore.setState({ activeOrcaProfileId: 'person-b' })
      return { ok: true, data: { sessionId: 'ses_abcd1234' } }
    })
    expect(await attachSessionToTask(session, 'btk_1234abcd')).toMatchObject({ attached: false })
    expect(attachSession).not.toHaveBeenCalled()
  })
})

it('creates a deliberate parent from the UI with zero session or handoff operations', async () => {
  createTask.mockResolvedValue({
    ok: true,
    taskId: 'btk_standalone',
    title: 'Independent outcome',
    principal: 'a'.repeat(64)
  })
  expect(
    await createTaskFromUi({
      title: 'Independent outcome',
      ownerEmployeeId: 'emp_sal',
      companyId: 'co_omnirogue',
      unitId: 'org_development',
      description: 'Shared brief',
      sequentialSteps: ['Human clarifies', 'AI drafts']
    })
  ).toMatchObject({ ok: true, taskId: 'btk_standalone', attached: false, sessionId: null })
  expect(createTask).toHaveBeenCalledTimes(1)
  expect(createTask).toHaveBeenCalledWith(
    expect.objectContaining({
      companyId: 'co_omnirogue',
      unitId: 'org_development',
      ownerEmployeeId: 'emp_sal',
      sequentialSteps: ['Human clarifies', 'AI drafts']
    })
  )
  expect(ingestSession).not.toHaveBeenCalled()
  expect(attachSession).not.toHaveBeenCalled()
  // A task made without a conversation has no row to file: the ledger is left alone.
  expect(linkCard).not.toHaveBeenCalled()
  expect(useSessionTasks.getState().links).toEqual({})
})

it('refreshes the current work lists immediately after a confirmed task creation', async () => {
  createTask.mockResolvedValue({ ok: true, taskId: 'btk_created01', title: 'New outcome' })
  await createTaskFromUi({ title: 'New outcome' })
  expect(invalidateWork).toHaveBeenCalledOnce()
})

it('does not refresh a different account when task creation settles after switching', async () => {
  const previousProfile = useAppStore.getState().activeOrcaProfileId
  createTask.mockImplementation(async () => {
    useAppStore.setState({ activeOrcaProfileId: 'changed-during-create' })
    return { ok: true, taskId: 'btk_created01', title: 'New outcome' }
  })
  try {
    await createTaskFromUi({ title: 'New outcome' })
    expect(invalidateWork).not.toHaveBeenCalled()
  } finally {
    useAppStore.setState({ activeOrcaProfileId: previousProfile })
  }
})

it('reports the attach refusal and remembers no local link when neither authority linked', async () => {
  createTask.mockResolvedValue({ ok: true, taskId: 'btk_1234abcd', title: 'Plan' })
  ingestSession.mockResolvedValue({ ok: true, data: { sessionId: 'ses_abcd1234' } })
  attachSession.mockResolvedValue({
    ok: false,
    error: { code: 'mutation_not_allowlisted', message: 'Session attachment unavailable' }
  })
  linkCard.mockResolvedValue(false)
  const outcome = await createTaskFromSession(session, { title: 'Plan' })
  expect(outcome).toMatchObject({
    ok: true,
    attached: false,
    ledgerLinked: false,
    contextWarning: expect.stringContaining(
      'Session attachment unavailable (mutation_not_allowlisted)'
    )
  })
  expect(useSessionTasks.getState().links).toEqual({})
})

it('keeps the created task and tries the ledger when the hub session request throws', async () => {
  createTask.mockResolvedValue({ ok: true, taskId: 'btk_saved', title: 'Saved idea' })
  ingestSession.mockRejectedValue(new Error('Connection dropped'))
  linkCard.mockResolvedValue(false)
  const result = await createTaskFromSession(session, { title: 'Saved idea' })
  expect(result).toMatchObject({
    ok: true,
    taskId: 'btk_saved',
    attached: false,
    ledgerLinked: false
  })
  expect(result.ok && result.contextWarning).toContain('Connection dropped')
  expect(linkCard).toHaveBeenCalledOnce()
  expect(Object.keys(useSessionTasks.getState().links)).toHaveLength(0)
  expect(createTask).toHaveBeenCalledOnce()
})
