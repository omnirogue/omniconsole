import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import type { Automation } from '../../../shared/automations-types'
import { readAutomaticCleanupProtection } from './automatic-session-cleanup-protection'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestRecord,
  addSessionTestTab,
  sessionTestSource,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE
} from './sidebar-session-test-fixtures'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const NOW = Date.parse('2026-10-02T12:00:00Z')
const TARGET = {
  worktreeId: SESSION_TEST_WORKTREE,
  tabId: 'tab-a',
  paneKey: `tab-a:${SESSION_TEST_LEAF}`
}
function state(): AppState {
  const source = sessionTestSource()
  source.worktreesByRepo['repo-a'][0].path = '/work/other'
  const tab = addSessionTestTab(source, TARGET.tabId)
  addSessionTestRecord(source, tab)
  return {
    ...source,
    settings: {
      automaticSessionCleanupProtection: {
        protectedWorkspacePaths: ['/work/email'],
        protectedPaneKeys: [],
        protectStartedToday: true,
        timeZone: 'America/New_York'
      }
    }
  } as unknown as AppState
}

beforeEach(() => {
  useSessionFolders.setState({
    loaded: true,
    metadata: { version: 1, folders: [], membership: {} }
  })
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  useRoutineSessionCatalog.setState({ owners: [], coverageByTarget: {} })
})

describe('renderer automatic cleanup protection producer', () => {
  it('keeps until the local routine catalog has positively completed a read', () => {
    const app = state()
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unknown')
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBeNull()
    useRoutineSessionCatalog.getState().setCoverage({ kind: 'local' }, 'loading')
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unknown')
    useRoutineSessionCatalog.getState().setCoverage({ kind: 'local' }, 'unavailable')
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unknown')
  })

  it('uses routine ownership and exact pane identity, independently of its title', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [
      {
        automation: {
          id: 'routine',
          conversation: { tabId: TARGET.tabId, paneKey: TARGET.paneKey }
        } as Automation,
        hostId: 'local',
        sourceTarget: { kind: 'local' },
        runs: []
      }
    ])
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('routine')
  })

  it('preserves a workspace subtree and a newly opened tab', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    app.worktreesByRepo['repo-a'][0].path = '/work/email/child'
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protected-workspace')
    app.worktreesByRepo['repo-a'][0].path = '/work/other'
    app.tabsByWorktree[SESSION_TEST_WORKTREE][0].createdAt = NOW
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('started-today')
  })

  it('keeps missing rows, a remote owner and unread saved placement', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    expect(readAutomaticCleanupProtection(app, { ...TARGET, paneKey: 'missing' }, NOW)).toBe(
      'protection-unknown'
    )
    useSessionFolders.setState({ loaded: false, load: vi.fn() })
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unknown')
    useSessionFolders.setState({ loaded: true })
    app.worktreesByRepo['repo-a'][0].hostId = 'ssh:other'
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unknown')
  })

  it('keeps default and older profiles with no protection configuration', () => {
    const app = state()
    delete app.settings!.automaticSessionCleanupProtection
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('protection-unconfigured')
  })
})

it('protects owner-local folder workspaces using their path identity', () => {
  const app = state()
  const worktreeId = 'folder:email'
  app.folderWorkspaces = [
    {
      id: 'email',
      projectGroupId: 'group',
      name: 'Renamed project',
      folderPath: '/work/email/operations',
      executionHostId: 'local'
    } as never
  ]
  app.projectGroups = [{ id: 'group', executionHostId: 'local' } as never]
  const tab = addSessionTestTab(app, 'folder-tab', worktreeId)
  addSessionTestRecord(app, tab)
  useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
  expect(
    readAutomaticCleanupProtection(
      app,
      {
        worktreeId,
        tabId: tab.id,
        paneKey: `${tab.id}:${SESSION_TEST_LEAF}`
      },
      NOW
    )
  ).toBe('protected-workspace')
})
