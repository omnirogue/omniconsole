import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { SidebarSession } from './sidebar-sessions'
import { isRoutineBackedSession, type RoutineSessionOwner } from './routine-backed-session'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree } from './session-sidebar-tree'

const session = {
  tabId: 'tab',
  paneKey: 'pane',
  hostId: 'local',
  rowKey: 'tab',
  sessionKey: null
} as SidebarSession
const automation = { id: 'routine', executionTargetType: 'local' } as Automation
const runFixture: AutomationRun = {
  id: 'run',
  automationId: 'routine',
  title: 'Run',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'manual',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1
}
const owner: RoutineSessionOwner = { automation, sourceTarget: { kind: 'local' } }
describe('routine session ownership', () => {
  it('keeps free-standing chats in Conversations', () => {
    expect(isRoutineBackedSession(session, [owner])).toBe(false)
  })
  it('matches the record and excludes it before building Conversation rows', () => {
    const owners = [
      { ...owner, automation: { ...automation, conversation: { tabId: 'tab', paneKey: null } } }
    ]
    expect(isRoutineBackedSession(session, owners)).toBe(true)
    const tree = buildSessionSidebarTree({
      sessions: [session],
      routineOwners: owners,
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      query: '',
      showHidden: false,
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      }
    } as Parameters<typeof buildSessionSidebarTree>[0])
    expect(tree.totalRows).toBe(0)
    expect(tree.groups.flatMap((group) => group.rows)).toEqual([])
  })
  it.each([{ terminalPaneKey: 'pane' }, { terminalSessionId: 'tab' }, { chatSessionId: 'chat' }])(
    'matches run identity %j',
    (run) => {
      expect(
        isRoutineBackedSession(
          { ...session, sessionKey: JSON.stringify(['local', 'structured', 'chat']) },
          [{ ...owner, runs: [{ ...runFixture, ...run }] }]
        )
      ).toBe(true)
    }
  )
  it('counts legacy bindings during migration', () => {
    expect(
      isRoutineBackedSession(session, [{ ...owner, legacy: { tabId: 'tab', paneKey: null } }])
    ).toBe(true)
  })
  it('never matches an identical tab id on another host', () => {
    expect(
      isRoutineBackedSession({ ...session, hostId: 'runtime:other' }, [
        { ...owner, automation: { ...automation, conversation: { tabId: 'tab', paneKey: null } } }
      ])
    ).toBe(false)
  })
})
