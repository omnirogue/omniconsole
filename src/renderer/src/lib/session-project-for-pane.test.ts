import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { emptyProjectSettings } from '../../../shared/project-settings'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { conversationViewKey } from './conversation-view'
import { sessionProjectForPane } from './session-project-for-pane'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions } from './sidebar-sessions'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const PROJECT = '00000000-0000-4000-8000-00000000000a'
const PANE = makePaneKey('tab-a', SESSION_TEST_LEAF)

function appState() {
  const source = sessionTestSource()
  addSessionTestRecord(source, addSessionTestTab(source, 'tab-a'), 'provider-a')
  const state = source as unknown as AppState
  return { state, key: conversationViewKey(buildSidebarSessions(state)[0]!) }
}

function folders(membership: Record<string, string>, coordinator?: string) {
  useSessionFolders.setState({
    loaded: true,
    metadata: {
      version: 1,
      folders: [{ id: PROJECT, name: 'Ads' }],
      membership,
      projects: {
        [PROJECT]: {
          ...emptyProjectSettings(1),
          ...(coordinator
            ? { coordinator: { launch: { agent: 'claude' }, sessionKey: coordinator } }
            : {})
        }
      }
    }
  })
}

beforeEach(() => {
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
})

describe('sessionProjectForPane', () => {
  it('names the project a pane is filed in', () => {
    const { state, key } = appState()
    folders({ [key]: PROJECT })
    expect(sessionProjectForPane(state, PANE, 1_000)).toBe(PROJECT)
  })

  it('names the project whose chat the pane is, though it is filed nowhere', () => {
    const { state, key } = appState()
    folders({}, key)
    expect(sessionProjectForPane(state, PANE, 1_000)).toBe(PROJECT)
  })

  it('is null for a pane in no project, or one it does not know', () => {
    const { state } = appState()
    folders({})
    expect(sessionProjectForPane(state, PANE, 1_000)).toBeNull()
    expect(sessionProjectForPane(state, makePaneKey('tab-z', SESSION_TEST_LEAF), 1_000)).toBeNull()
  })
})
