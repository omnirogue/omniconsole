import { beforeEach, expect, it, vi } from 'vitest'
import { conversationSourceForPane, upNextAddressForPane } from './conversation-source-for-pane'
import { buildSidebarSessions, type SidebarSessionSource } from './sidebar-sessions'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from './sidebar-session-test-fixtures'

const store = vi.hoisted(() => ({ source: null as SidebarSessionSource | null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.source } }))

beforeEach(() => {
  store.source = sessionTestSource()
})

it.each(['local', 'runtime:peer'] as const)(
  'addresses the resumed pane on %s even with its older tab still present',
  (hostId) => {
    const state = store.source!
    state.repos = [{ ...state.repos[0]!, executionHostId: hostId }]
    state.worktreesByRepo['repo-a'][0] = { ...state.worktreesByRepo['repo-a'][0]!, hostId }
    const original = addSessionTestRecord(state, addSessionTestTab(state, 'original'))
    const resumed = addSessionTestRecord(state, addSessionTestTab(state, 'resumed'))
    expect(buildSidebarSessions(state).map((row) => row.paneKey)).toEqual([original.paneKey])

    const source = { kind: 'pty', worktreeId: resumed.worktreeId, paneKey: resumed.paneKey }
    expect(upNextAddressForPane(resumed.paneKey, resumed.tabId!)).toEqual({
      source,
      owner: hostId === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'peer' }
    })
    expect(conversationSourceForPane(resumed.paneKey, resumed.tabId!)).toEqual(
      hostId === 'local' ? source : null
    )
    expect(upNextAddressForPane('resumed:missing', resumed.tabId!)).toBeNull()
  }
)
