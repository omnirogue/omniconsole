// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWaitLater } from '@/store/wait-later-store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SESSION_OUTCOME_RELAY_REFUSAL } from '../../../../shared/session-outcome-routing'
import { doneRefusal, finishNextStep } from './next-step-actions'

const outcomes = vi.hoisted(() => ({ list: vi.fn(), progress: vi.fn() }))
vi.mock('./next-step-outcome-client', () => ({
  getOutcomeProgress: outcomes.progress,
  listSessionOutcomesForOwner: outcomes.list
}))

const registry = vi.hoisted(() => ({ all: vi.fn(() => []) }))
vi.mock('@/lib/session-chain-registry', () => ({ getAllSessionChainEntries: registry.all }))

const api = vi.hoisted(() => ({ respond: vi.fn() }))
const invalidate = vi.hoisted(() => vi.fn())
const closeTerminalTab = vi.hoisted(() =>
  vi.fn((_tabId: string, options?: { onClosed?: () => void; onCancel?: () => void }) =>
    options?.onClosed?.()
  )
)
const agentStatusByPaneKey = vi.hoisted(() => ({}) as Record<string, { state: string }>)
vi.mock('@/components/terminal/terminal-tab-actions', () => ({ closeTerminalTab }))
let knownWorktree: { linkedWorkItem?: { hubTaskId?: string } } | undefined
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ agentStatusByPaneKey, getKnownWorktreeById: () => knownWorktree })
  }
}))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  invalidateBackofficeWork: invalidate
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 's',
  worktreeId: 'folder:f1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Build',
  workspaceLabel: 'W',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}
const item = { task_id: 'btk_1', title: 'Card', state_revision: 4 }
const thread = {
  thread: {
    id: 'hth_1',
    board_task_id: 'btk_1',
    author_employee_id: 'emp_a',
    recipient_employee_id: 'emp_me',
    title: 'T',
    state: 'open' as const,
    action: null,
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: ''
  },
  files: [],
  reviews: [],
  entries: []
}

beforeEach(() => {
  registry.all.mockReset().mockReturnValue([])
  outcomes.list.mockReset().mockResolvedValue([])
  outcomes.progress.mockReset()
  localStorage.clear()
  useWaitLater.getState().load()
  api.respond.mockReset()
  invalidate.mockClear()
})

describe('✓ Done', () => {
  it('keeps a linked session open until the hub accepts its completion evidence', async () => {
    closeTerminalTab.mockClear()
    for (const key of Object.keys(agentStatusByPaneKey)) {
      delete agentStatusByPaneKey[key]
    }
    const completeTask = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsEvidence: true, message: 'A result is required.' })
      .mockResolvedValueOnce({ ok: true })
    Object.assign(window, { api: { backoffice: { completeTask } } })
    expect(await finishNextStep({ kind: 'session', session }, item)).toEqual({
      ok: false,
      message: 'A result is required.',
      evidenceItem: item
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(useWaitLater.getState().finished.has('pane:tab:leaf')).toBe(false)
    expect(
      await finishNextStep({ kind: 'session', session }, item, '  Verified the release  ')
    ).toMatchObject({ ok: true })
    expect(completeTask).toHaveBeenLastCalledWith({
      taskId: 'btk_1',
      expectedRevision: 4,
      resultRef: 'Verified the release'
    })
    expect(closeTerminalTab).toHaveBeenCalledTimes(1)
    closeTerminalTab.mockClear()
  })

  it('offers evidence for a card only when the hub explicitly requires it', async () => {
    const completeTask = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsEvidence: true, message: 'A result is required.' })
      .mockResolvedValueOnce({ ok: false, message: 'Permission denied.' })
    Object.assign(window, { api: { backoffice: { completeTask } } })
    expect(await finishNextStep({ kind: 'card', item }, null)).toMatchObject({ evidenceItem: item })
    expect(await finishNextStep({ kind: 'card', item }, null)).toEqual({
      ok: false,
      message: 'Permission denied.'
    })
  })

  it('resolves a thread with the hub’s own done entry', async () => {
    api.respond.mockResolvedValue({ ok: true, data: { thread_id: 'hth_1' } })
    expect(
      await finishNextStep({ kind: 'thread', detail: thread, viewer: 'emp_me' }, null)
    ).toMatchObject({ ok: true })
    expect(api.respond).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'hth_1', kind: 'done', note: 'Done.' })
    )
  })

  it('completes a card; a session closes with or without a card, never while working', async () => {
    const completeTask = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { api: { backoffice: { completeTask } } })
    expect(await finishNextStep({ kind: 'card', item }, null)).toMatchObject({ ok: true })
    expect(completeTask).toHaveBeenCalledWith({ taskId: 'btk_1', expectedRevision: 4 })
    expect(doneRefusal({ kind: 'card', item: { ...item, status: 'done' } }, null)).toBe('Completed')

    // Why: ✓ on a session is normal completion: the tab closes (history kept), nothing is killed.
    expect(doneRefusal({ kind: 'session', session }, null)).toBeNull()
    agentStatusByPaneKey['tab:leaf'] = { state: 'working' }
    expect(await finishNextStep({ kind: 'session', session }, null)).toMatchObject({
      ok: false,
      message: expect.stringContaining('still working')
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
    agentStatusByPaneKey['tab:leaf'] = { state: 'done' }
    expect(await finishNextStep({ kind: 'session', session }, null)).toMatchObject({
      ok: true,
      message: 'Done. The session is closed; reopen it from Recently closed.'
    })
    expect(closeTerminalTab).toHaveBeenCalledWith(
      'tab',
      expect.objectContaining({
        reason: 'user',
        captureRecentlyClosed: true,
        skipRunningProcessConfirm: true
      })
    )
    expect(useWaitLater.getState().finished.has('pane:tab:leaf')).toBe(true)
    expect(completeTask).toHaveBeenCalledTimes(1)

    // With a bound card, the card is completed as well.
    expect(await finishNextStep({ kind: 'session', session }, item)).toMatchObject({
      ok: true,
      message: 'Done. The session is closed; reopen it from Recently closed. Card is complete.'
    })
    expect(completeTask).toHaveBeenLastCalledWith({ taskId: 'btk_1', expectedRevision: 4 })

    // Why: closing the tab ends every pane in it; a working sibling pane is protected too.
    agentStatusByPaneKey['tab:other'] = { state: 'working' }
    expect(await finishNextStep({ kind: 'session', session }, null)).toMatchObject({
      ok: false,
      message: expect.stringContaining('still working')
    })
    delete agentStatusByPaneKey['tab:other']

    // A card the workspace names but Tasks has not read is not claimed complete.
    knownWorktree = { linkedWorkItem: { hubTaskId: 'btk_1' } }
    expect(await finishNextStep({ kind: 'session', session }, null)).toMatchObject({
      ok: true,
      message: expect.stringContaining('could not be completed from here')
    })
    knownWorktree = undefined

    // A declined close is reported as such, never as closed.
    closeTerminalTab.mockImplementationOnce((_tabId, options) => options?.onCancel?.())
    expect(await finishNextStep({ kind: 'session', session }, null)).toMatchObject({
      ok: true,
      message: expect.stringContaining('stayed open')
    })
  })
})

describe('Done with committed outcomes', () => {
  it('checks the host before renderer hydration and preserves partially finished work', async () => {
    closeTerminalTab.mockClear()
    const completeTask = vi.fn()
    Object.assign(window, { api: { backoffice: { completeTask } } })
    outcomes.list.mockResolvedValue([
      { id: 'bound', sourceRowKey: session.rowKey, outcomeSet: {}, steps: [] }
    ])
    outcomes.progress.mockResolvedValue({
      lifecycle: 'waiting',
      satisfied: 1,
      total: 2,
      reasons: []
    })
    const result = await finishNextStep({ kind: 'session', session }, item)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('1 of 2 outcomes complete')
    expect(outcomes.progress).toHaveBeenCalledWith(
      'bound',
      expect.objectContaining({ id: 'bound', sourceRowKey: session.rowKey })
    )
    expect(completeTask).not.toHaveBeenCalled()
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('cannot mark an unavailable execution host complete', async () => {
    closeTerminalTab.mockClear()
    outcomes.list.mockRejectedValue(new Error('disconnected'))
    expect(await finishNextStep({ kind: 'session', session }, null)).toEqual({
      ok: false,
      message: 'The execution host could not verify saved outcomes. Reconnect and try again.'
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })
})

describe('Done on relay-only SSH', () => {
  const remote = { ...session, hostId: 'ssh:server' as const }
  beforeEach(() => {
    closeTerminalTab.mockClear()
    Object.keys(agentStatusByPaneKey).forEach((key) => delete agentStatusByPaneKey[key])
  })
  it('preserves legacy Done when the host cannot hold durable outcomes', async () => {
    outcomes.list.mockRejectedValue(new Error(SESSION_OUTCOME_RELAY_REFUSAL))
    expect(await finishNextStep({ kind: 'session', session: remote }, null)).toMatchObject({
      ok: true
    })
    expect(closeTerminalTab).toHaveBeenCalledTimes(1)
  })
  it('still refuses an actual unavailable host', async () => {
    outcomes.list.mockRejectedValue(new Error('disconnected'))
    expect(await finishNextStep({ kind: 'session', session: remote }, null)).toMatchObject({
      ok: false
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })
  it('cannot discard a known saved obligation after a relay refusal', async () => {
    outcomes.list.mockRejectedValue(new Error(SESSION_OUTCOME_RELAY_REFUSAL))
    registry.all.mockReturnValue([
      { chain: { outcomeSet: {}, sourcePaneKey: remote.paneKey, steps: [] } }
    ] as never)
    expect(await finishNextStep({ kind: 'session', session: remote }, null)).toMatchObject({
      ok: false
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })
})
