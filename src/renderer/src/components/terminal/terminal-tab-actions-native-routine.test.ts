// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  closeOwner: vi.fn(),
  callRuntimeRpc: vi.fn(),
  updateAutomation: vi.fn(),
  closeTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  resolveOwner: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeOwner
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/terminal-worktree-route', () => ({
  resolveTerminalHostOwnership: mocks.resolveOwner
}))
vi.mock('@/lib/resolved-worktree-execution-host', () => ({
  getResolvedExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))
vi.mock('@/components/automations/automation-host-client', () => ({
  updateAutomationForTarget: mocks.updateAutomation,
  getAutomationHostTargetKey: (target: { kind: string; environmentId?: string }) =>
    target.environmentId ?? target.kind
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { closeTerminalTab } from './terminal-tab-actions'
import { useRoutineSessionCatalog } from '../sidebar/routines/routine-session-catalog'
import { useRoutineConversations } from '../sidebar/routines/routine-conversation-state'

const tab = {
  id: 'structured-agent-session-native',
  entityId: 'native',
  contentType: 'agent-session',
  worktreeId: 'workspace',
  groupId: 'group',
  label: 'Codex Chat'
}
const conversation = { tabId: tab.id, paneKey: null }
const automation = { id: 'routine', executionTargetType: 'local', conversation } as Automation
let state: ReturnType<typeof createState>
function createState() {
  return {
    settings: {},
    activeWorktreeId: 'workspace',
    tabsByWorktree: { workspace: [] },
    unifiedTabsByWorktree: { workspace: [tab] },
    closeTab: mocks.closeTab,
    closeUnifiedTab: mocks.closeUnifiedTab
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  state = createState()
  mocks.getState.mockImplementation(() => state)
  mocks.resolveOwner.mockReturnValue({ kind: 'local-or-ssh', runtimeEnvironmentId: null })
  mocks.closeOwner.mockResolvedValue('closed')
  mocks.callRuntimeRpc.mockResolvedValue(undefined)
  mocks.closeUnifiedTab.mockImplementation(() => {
    state.unifiedTabsByWorktree.workspace = []
    return { closedTabId: tab.id, worktreeId: 'workspace', wasLastTab: true }
  })
  mocks.updateAutomation.mockImplementation(async (record, updates) => ({ ...record, ...updates }))
  useRoutineSessionCatalog.setState({
    owners: [{ automation, sourceTarget: { kind: 'local' } }]
  })
  useRoutineConversations.setState({ byRoutine: {} })
})

it('closes a native routine chat on its host, unbinds it, and keeps the schedule', async () => {
  const onClosed = vi.fn()
  closeTerminalTab(tab.id, { reason: 'user', captureRecentlyClosed: false, onClosed })
  await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
  expect(mocks.closeOwner).toHaveBeenCalledWith({ kind: 'local' }, tab.entityId)
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
    worktree: 'id:workspace',
    tabId: 'agent-session:native',
    reason: 'user'
  })
  expect(mocks.closeUnifiedTab).toHaveBeenCalledWith(tab.id)
  expect(mocks.closeTab).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(mocks.updateAutomation).toHaveBeenCalledOnce())
  expect(useRoutineSessionCatalog.getState().owners).toHaveLength(1)
  expect(useRoutineSessionCatalog.getState().owners[0].automation).toMatchObject({
    id: 'routine',
    conversation: null
  })
})

it('keeps the binding and tab if the native owner refuses closure', async () => {
  mocks.closeOwner.mockRejectedValue(new Error('owner unavailable'))
  const onClosed = vi.fn()
  const onCancel = vi.fn()
  closeTerminalTab(tab.id, { onClosed, onCancel })
  await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  expect(onClosed).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  expect(mocks.updateAutomation).not.toHaveBeenCalled()
  expect(useRoutineSessionCatalog.getState().owners[0].automation.conversation).toEqual(
    conversation
  )
})

it('keeps the binding until the host confirms removal of the canonical tab', async () => {
  let finish!: () => void
  mocks.callRuntimeRpc.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const onClosed = vi.fn()
  closeTerminalTab(tab.id, { onClosed })
  await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce())
  expect(mocks.updateAutomation).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
  expect(mocks.closeUnifiedTab).toHaveBeenCalledOnce()
})

it('routes a paired native chat to its owner and only unbinds that host', async () => {
  const target = { kind: 'environment', environmentId: 'paired' } as const
  mocks.resolveOwner.mockReturnValue({ kind: 'runtime', runtimeEnvironmentId: 'paired' })
  useRoutineSessionCatalog.setState({
    owners: [
      { automation, sourceTarget: { kind: 'local' } },
      { automation, sourceTarget: target }
    ]
  })
  closeTerminalTab(tab.id)
  await vi.waitFor(() => expect(mocks.updateAutomation).toHaveBeenCalledOnce())
  expect(mocks.resolveOwner).toHaveBeenCalledWith(state, 'workspace', 'teardown')
  expect(mocks.closeOwner).toHaveBeenCalledWith(target, tab.entityId)
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(target, 'session.tabs.close', {
    worktree: 'id:workspace',
    tabId: 'agent-session:native',
    reason: 'user'
  })
  expect(mocks.updateAutomation).toHaveBeenCalledWith(automation, { conversation: null }, target)
  expect(useRoutineSessionCatalog.getState().owners[0].automation.conversation).toEqual(
    conversation
  )
})

it('retains the binding when the host cannot acknowledge canonical tab removal', async () => {
  mocks.callRuntimeRpc.mockRejectedValue(new Error('host disconnected'))
  const onCancel = vi.fn()
  closeTerminalTab(tab.id, { onCancel })
  await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.updateAutomation).not.toHaveBeenCalled()
})

it('does not discard a native chat on a host without structured close support', async () => {
  mocks.closeOwner.mockResolvedValue('unsupported')
  const onCancel = vi.fn()
  closeTerminalTab(tab.id, { onCancel })
  await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.updateAutomation).not.toHaveBeenCalled()
})

it('never substitutes the local host when ownership is unresolved', () => {
  mocks.resolveOwner.mockReturnValue({ kind: 'unresolved', runtimeEnvironmentId: null })
  const onCancel = vi.fn()
  closeTerminalTab(tab.id, { onCancel })
  expect(onCancel).toHaveBeenCalledOnce()
  expect(mocks.closeOwner).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.updateAutomation).not.toHaveBeenCalled()
})
