// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
const mocks = vi.hoisted(() => ({
  close: vi.fn((_id, options) => options.onClosed()),
  runs: vi.fn().mockResolvedValue([{ terminalSessionId: 'run-tab' }])
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/sidebar-sessions', () => ({
  buildSidebarSessions: () => [
    { tabId: 'bound-tab', hostId: 'local' },
    { tabId: 'run-tab', hostId: 'local' },
    { tabId: 'free', hostId: 'local' }
  ]
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.close }))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: mocks.runs,
  getAutomationHostTargetKey: () => 'local'
}))
import {
  closeRoutineConversations,
  forgetRoutineConversations
} from './delete-routine-conversations'
import { useRoutineConversations } from './routine-conversation-state'
import { useRoutineSessionCatalog } from './routine-session-catalog'
it('deleting a routine closes bound and run tabs without recently-closed capture and unbinds', async () => {
  const automation = {
    id: 'routine',
    executionTargetType: 'local',
    conversation: { tabId: 'bound-tab', paneKey: null }
  } as Automation
  const sourceTarget = { kind: 'local' } as const
  useRoutineSessionCatalog.setState({ owners: [{ automation, sourceTarget }] })
  useRoutineConversations.setState({
    byRoutine: {
      '["local","routine"]': { automation, sourceTarget, tabId: 'bound-tab', paneKey: null }
    }
  })
  await closeRoutineConversations(automation, sourceTarget)
  forgetRoutineConversations(automation, sourceTarget)
  expect(mocks.close.mock.calls.map(([id]) => id)).toEqual(['bound-tab', 'run-tab'])
  expect(mocks.close).toHaveBeenCalledWith(
    'bound-tab',
    expect.objectContaining({ reason: 'user', captureRecentlyClosed: false })
  )
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
  expect(useRoutineSessionCatalog.getState().owners).toEqual([])
})
