// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
import type { SidebarSession } from '@/lib/sidebar-sessions'
const update = vi.hoisted(() => vi.fn())
vi.mock('@/components/automations/automation-host-client', () => ({
  updateAutomationForTarget: update,
  getAutomationHostTargetKey: () => 'local'
}))
import { useRoutineConversations } from './routine-conversation-state'
import { useRoutineSessionCatalog } from './routine-session-catalog'
import { migrateRoutineConversations } from './routine-conversation-migration'
import { unbindClosedRoutineConversation } from './close-routine-conversation'
import { bindRoutineConversation } from './routine-conversation-binding'

const automation = { id: 'routine', executionTargetType: 'local' } as Automation
const sourceTarget = { kind: 'local' } as const
const key = JSON.stringify(['local', 'routine'])
const entry = { automation, sourceTarget, tabId: 'tab', paneKey: null }
const session = {
  tabId: 'tab',
  paneKey: null,
  hostId: 'local',
  sessionKey: null,
  unavailable: false
} as SidebarSession
beforeEach(() => {
  vi.clearAllMocks()
  useRoutineConversations.setState({ byRoutine: { [key]: entry } })
  useRoutineSessionCatalog.setState({ owners: [] })
  update.mockImplementation(async (record, patch) => ({ ...record, ...patch }))
})
it('unbind removes only the named migration entry', () => {
  useRoutineConversations.getState().unbind(key)
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})
it('reconcile drops dead bindings and retains live bindings', () => {
  useRoutineConversations.getState().reconcile([session])
  expect(useRoutineConversations.getState().byRoutine[key]).toEqual(entry)
  useRoutineConversations.getState().reconcile([])
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})
it('migration writes the record before clearing the legacy entry', async () => {
  update.mockImplementation(async (record, patch) => {
    expect(useRoutineConversations.getState().byRoutine[key]).toBeDefined()
    return { ...record, ...patch }
  })
  await migrateRoutineConversations([{ automation, sourceTarget }], [session])
  expect(update).toHaveBeenCalledWith(
    automation,
    { conversation: { tabId: 'tab', paneKey: null, sessionKey: null } },
    sourceTarget
  )
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})
it('keeps the migration source if saving fails', async () => {
  update.mockRejectedValue(new Error('offline'))
  await expect(
    migrateRoutineConversations([{ automation, sourceTarget }], [session])
  ).rejects.toThrow('offline')
  expect(useRoutineConversations.getState().byRoutine[key]).toBeDefined()
})
it('keeps a binding whose save failed and saves it at the next sync, over the record', async () => {
  useRoutineConversations.setState({ byRoutine: {} })
  update.mockRejectedValueOnce(new Error('offline'))
  const conversation = { tabId: 'tab', paneKey: null, sessionKey: 'chat' }
  await expect(bindRoutineConversation(automation, sourceTarget, conversation)).rejects.toThrow(
    'offline'
  )
  expect(useRoutineConversations.getState().byRoutine[key]).toMatchObject({
    ...conversation,
    unsaved: true
  })

  await migrateRoutineConversations(
    [
      {
        automation: { ...automation, conversation: { tabId: 'stale', paneKey: null } },
        sourceTarget
      }
    ],
    [session]
  )
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'routine' }),
    { conversation: { tabId: 'tab', paneKey: null, sessionKey: 'chat' } },
    sourceTarget
  )
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})
it('record binding wins during migration', async () => {
  await migrateRoutineConversations(
    [
      {
        automation: { ...automation, conversation: { tabId: 'record', paneKey: null } },
        sourceTarget
      }
    ],
    [session]
  )
  expect(update).not.toHaveBeenCalled()
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})
it('closing a bound conversation clears its record binding and keeps the routine', async () => {
  useRoutineSessionCatalog.setState({
    owners: [
      { automation: { ...automation, conversation: { tabId: 'tab', paneKey: null } }, sourceTarget }
    ]
  })
  await unbindClosedRoutineConversation('tab')
  expect(useRoutineSessionCatalog.getState().owners).toHaveLength(1)
  expect(useRoutineSessionCatalog.getState().owners[0].automation).toMatchObject({
    id: 'routine',
    conversation: null
  })
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})

it('does not prune an offline authority using another host snapshot', () => {
  useRoutineConversations.setState({
    byRoutine: {
      [key]: {
        ...entry,
        automation: { ...automation, executionTargetType: 'ssh', executionTargetId: 'remote' }
      }
    }
  })
  useRoutineConversations.getState().reconcile([], ['local'])
  expect(useRoutineConversations.getState().byRoutine[key]).toBeDefined()
})

it('clears an orphaned legacy entry only after its own authority answers', async () => {
  await migrateRoutineConversations([], [session], sourceTarget)
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})

it('serializes close behind a pending bind without restoring the closed identity', async () => {
  let finishBinding!: (value: Automation) => void
  update.mockImplementationOnce(
    () =>
      new Promise<Automation>((resolve) => {
        finishBinding = resolve
      })
  )
  const binding = { tabId: 'tab', paneKey: null }
  const bind = bindRoutineConversation(automation, sourceTarget, binding)
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  const close = unbindClosedRoutineConversation('tab', 'local')
  expect(useRoutineSessionCatalog.getState().owners[0].automation.conversation).toBeNull()
  finishBinding({ ...automation, conversation: binding })
  await bind
  expect(useRoutineSessionCatalog.getState().owners[0].automation.conversation).toBeNull()
  await close
  expect(update.mock.calls.map((call) => call[1].conversation)).toEqual([binding, null])
})

it('does not restore a failed pending binding after its conversation was closed', async () => {
  useRoutineConversations.setState({ byRoutine: {} })
  let rejectBinding!: (reason: Error) => void
  update.mockImplementationOnce(
    () =>
      new Promise<Automation>((_, reject) => {
        rejectBinding = reject
      })
  )
  const bind = bindRoutineConversation(automation, sourceTarget, { tabId: 'tab', paneKey: null })
  const failed = expect(bind).rejects.toThrow('offline')
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  const close = unbindClosedRoutineConversation('tab', 'local')
  rejectBinding(new Error('offline'))
  await failed
  await close
  expect(useRoutineConversations.getState().byRoutine).toEqual({})
})

it('retains the resolved execution host when a binding save fails', async () => {
  update.mockRejectedValueOnce(new Error('offline'))
  await expect(
    bindRoutineConversation(
      automation,
      sourceTarget,
      { tabId: 'tab', paneKey: null },
      'runtime:peer'
    )
  ).rejects.toThrow('offline')
  useRoutineConversations.getState().reconcile([{ ...session, hostId: 'runtime:peer' }])
  expect(useRoutineConversations.getState().byRoutine[key]).toMatchObject({
    hostId: 'runtime:peer',
    unsaved: true
  })
})

it('closing a local tab cannot clear a different host with the same tab id', async () => {
  const remote = {
    ...automation,
    executionTargetType: 'ssh' as const,
    executionTargetId: 'remote',
    conversation: { tabId: 'tab', paneKey: null }
  }
  useRoutineSessionCatalog.setState({ owners: [{ automation: remote, sourceTarget }] })
  await unbindClosedRoutineConversation('tab', 'local')
  expect(update).not.toHaveBeenCalled()
  expect(useRoutineSessionCatalog.getState().owners[0].automation.conversation).toEqual(
    remote.conversation
  )
})
