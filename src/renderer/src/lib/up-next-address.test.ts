import { beforeEach, expect, it, vi } from 'vitest'
import { conversationSourceForPane, upNextAddressForPane } from './conversation-source-for-pane'
import { upNextAddressForSession } from './up-next-address'
import type { SidebarSession } from './sidebar-sessions'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

const state = vi.hoisted(() => ({ sessions: [] as unknown[] }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => state.sessions }))
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'runtime:a',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Work',
  workspaceLabel: 'Workspace',
  agent: 'omp',
  unavailable: false,
  folderKeyMigration: null
}
beforeEach(() => {
  state.sessions = [session]
})

it('captures a peer address without enabling the legacy local-only source adapter', () => {
  expect(conversationSourceForPane('tab:leaf', 'tab')).toBeNull()
  expect(upNextAddressForPane('tab:leaf', 'tab')).toEqual({
    source: { kind: 'pty', worktreeId: 'folder:1', paneKey: 'tab:leaf' },
    owner: { kind: 'environment', environmentId: 'a' }
  })
})

it('refuses ambiguous same-pane identities instead of picking the first host', () => {
  state.sessions.push({ ...session, hostId: 'local' })
  expect(upNextAddressForPane('tab:leaf', 'tab')).toBeNull()
})

it.each(['ssh:a', 'unknown'])('refuses unowned execution host %s', (hostId) => {
  expect(upNextAddressForSession({ ...session, hostId } as SidebarSession)).toBeNull()
})

it('does not borrow a sibling pane or return an address without a pane', () => {
  expect(upNextAddressForPane('tab:other', 'tab')).toBeNull()
  expect(upNextAddressForSession({ ...session, paneKey: null })).toBeNull()
})

it('retains the peer owner for a structured conversation', () => {
  const addressed = upNextAddressForSession({
    ...session,
    kind: 'structured',
    paneKey: null,
    tabId: structuredAgentSessionTabId('native-a')
  })
  expect(addressed).toMatchObject({
    owner: { kind: 'environment', environmentId: 'a' },
    source: { kind: 'structured', worktreeId: 'folder:1', sessionId: 'native-a' }
  })
})
