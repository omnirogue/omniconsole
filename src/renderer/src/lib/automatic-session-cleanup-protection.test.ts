import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import { useRoutineConversations } from '@/components/sidebar/routines/routine-conversation-state'
import type { Automation } from '../../../shared/automations-types'
import { normalizeAutomaticSessionCleanupProtection } from '../../../shared/automatic-session-cleanup-protection'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import {
  automaticCleanupProtectionForRow,
  readAutomaticCleanupProtection,
  type AutomaticCleanupProtectionOptions,
  type AutomaticCleanupTarget
} from './automatic-session-cleanup-protection'
import { judgeArchivedPane, type ArchiveSleepDeps } from './archive-sleep-evaluate'
import {
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from './foreground-terminal-tabs'
import { sessionDoneArchiveRevision } from './session-done-archive-policy'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'
import { applyWhenFinished, scheduleWhenFinished } from './session-when-finished'
import type { SidebarSession } from './sidebar-sessions'
import {
  addSessionTestRecord,
  addSessionTestTab,
  sessionTestSource,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE
} from './sidebar-session-test-fixtures'

const finish = vi.hoisted(() => ({
  read: vi.fn(),
  close: vi.fn(async (_tabId: string, _options?: unknown) => true),
  busy: vi.fn((_tabId: string) => false)
}))

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
type SidebarRowsModule = { buildSessionManageSidebarRows: typeof buildSessionManageSidebarRows }
// Why a pass-through spy: counts full builds, and can feed rows the real builder cannot make.
vi.mock('./session-manage-sidebar-rows', async (importOriginal) => {
  const actual = await importOriginal<SidebarRowsModule>()
  return { ...actual, buildSessionManageSidebarRows: vi.fn(actual.buildSessionManageSidebarRows) }
})
vi.mock('@/components/next-action/up-next-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUpNext: (...args: unknown[]) => finish.read(...args)
}))
vi.mock('@/components/next-action/up-next-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  upNextConnection: () => ({ assertCurrent: () => {} })
}))
vi.mock('./close-session-tab', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  closeSessionTab: (tabId: string, options?: unknown) => finish.close(tabId, options),
  sessionTabHasUnfinishedAgent: (tabId: string) => finish.busy(tabId)
}))

const { buildSessionManageSidebarRows: realBuild } = await vi.importActual<SidebarRowsModule>(
  './session-manage-sidebar-rows'
)
const build = vi.mocked(buildSessionManageSidebarRows)

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
  build.mockReset()
  build.mockImplementation(realBuild)
  useSessionFolders.setState({
    loaded: true,
    metadata: { version: 1, folders: [], membership: {} }
  })
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  useRoutineSessionCatalog.setState({ owners: [], coverageByTarget: {} })
  useRoutineConversations.setState({ byRoutine: {} })
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

// The pre-#1214 lookup, verbatim: one full sidebar build per question.
function fullScan(
  app: AppState,
  target: AutomaticCleanupTarget,
  now: number,
  options?: AutomaticCleanupProtectionOptions
): string | null {
  if (
    !normalizeAutomaticSessionCleanupProtection(app.settings?.automaticSessionCleanupProtection)
  ) {
    return 'protection-unconfigured'
  }
  try {
    const row = realBuild(app, now).find(
      (entry) =>
        entry.worktreeId === target.worktreeId &&
        entry.tabId === target.tabId &&
        entry.paneKey === target.paneKey
    )
    return row ? automaticCleanupProtectionForRow(app, row, now, options) : 'protection-unknown'
  } catch {
    return 'protection-unknown'
  }
}

// Deterministic PRNG (mulberry32) so a failure names a seed that replays exactly.
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!

const PATHS = ['/work/email', '/work/email/ops', '/work/other', '/work/ads', '/work/emailer']

function randomState(rng: () => number): { app: AppState; targets: AutomaticCleanupTarget[] } {
  const source = sessionTestSource()
  const worktrees = source.worktreesByRepo['repo-a']
  worktrees[0].path = pick(rng, PATHS)
  for (let w = 1, count = 1 + Math.floor(rng() * 5); w <= count; w += 1) {
    worktrees.push({
      ...worktrees[0],
      id: `repo-a::/p${w}`,
      path: pick(rng, PATHS),
      hostId: rng() < 0.15 ? 'ssh:other' : 'local'
    })
  }
  const targets: AutomaticCleanupTarget[] = []
  for (const worktree of worktrees) {
    for (let t = 0, tabs = Math.floor(rng() * 4); t < tabs; t += 1) {
      const tab = addSessionTestTab(source, `${worktree.id.slice(9) || 'a'}-t${t}`, worktree.id)
      tab.createdAt = rng() < 0.3 ? NOW - 60_000 : 10
      addSessionTestRecord(source, tab, `provider-${worktree.id}-${t}`)
      if (rng() < 0.2) {
        source.unifiedTabsByWorktree[worktree.id] = [
          ...(source.unifiedTabsByWorktree[worktree.id] ?? []),
          { id: `u-${tab.id}`, entityId: tab.id, contentType: 'terminal', isPinned: true } as never
        ]
      }
      targets.push({
        worktreeId: worktree.id,
        tabId: tab.id,
        paneKey: `${tab.id}:${SESSION_TEST_LEAF}`
      })
    }
  }
  // Near misses: the right pane under the wrong workspace or tab, and a pane that does not exist.
  const decoys = targets.flatMap((target) => [
    { ...target, worktreeId: pick(rng, worktrees).id },
    { ...target, tabId: pick(rng, targets).tabId },
    { ...target, paneKey: `${target.tabId}:missing` }
  ])
  const app = {
    ...source,
    settings: {
      automaticSessionCleanupProtection: {
        protectedWorkspacePaths: ['/work/email'],
        protectedPaneKeys: targets.filter(() => rng() < 0.1).map((target) => target.paneKey),
        protectStartedToday: rng() < 0.8,
        timeZone: 'America/New_York'
      }
    }
  } as unknown as AppState
  return { app, targets: [...targets, ...decoys] }
}

/** One change a store can make between two questions asked with the same snapshot time. */
function mutate(rng: () => number, app: AppState, targets: AutomaticCleanupTarget[]): AppState {
  const target = pick(rng, targets)
  switch (Math.floor(rng() * 6)) {
    case 0: {
      const rows = realBuild(app, NOW).filter(() => rng() < 0.4)
      const membership = Object.fromEntries(
        rows.map((row) => [row.viewKey, SAVED_SESSIONS_FOLDER_ID])
      )
      useSessionFolders.setState({ metadata: { ...emptySessionFolderMetadata(), membership } })
      return app
    }
    case 1:
      useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [
        {
          automation: { id: `r-${target.tabId}`, conversation: target } as unknown as Automation,
          hostId: 'local',
          sourceTarget: { kind: 'local' },
          runs: []
        }
      ])
      return app
    case 2:
      useRoutineConversations.setState({
        byRoutine: {
          [`legacy-${target.tabId}`]: {
            automation: { id: `legacy-${target.tabId}` } as Automation,
            sourceTarget: { kind: 'local' },
            tabId: target.tabId,
            paneKey: target.paneKey
          }
        }
      })
      return app
    case 3: {
      const pinned = {
        id: `u-${target.tabId}`,
        entityId: target.tabId,
        contentType: 'terminal',
        isPinned: true
      }
      return {
        ...app,
        unifiedTabsByWorktree: {
          ...app.unifiedTabsByWorktree,
          [target.worktreeId]: [pinned as never]
        }
      }
    }
    case 4:
      return {
        ...app,
        worktreesByRepo: {
          'repo-a': app.worktreesByRepo['repo-a'].map((worktree) =>
            worktree.id === target.worktreeId ? { ...worktree, path: pick(rng, PATHS) } : worktree
          )
        }
      }
    default: {
      const tabs = (app.tabsByWorktree[target.worktreeId] ?? []).filter(() => rng() < 0.7)
      return { ...app, tabsByWorktree: { ...app.tabsByWorktree, [target.worktreeId]: tabs } }
    }
  }
}

describe('cleanup protection cache (#1214)', () => {
  it('answers exactly as the old full scan on randomised rows, before and after every change', () => {
    const seen = new Set<string | null>()
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = prng(seed)
      useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
      useRoutineConversations.setState({ byRoutine: {} })
      useSessionFolders.setState({ metadata: emptySessionFolderMetadata() })
      let { app, targets } = randomState(rng)
      if (targets.length === 0) {
        continue
      }
      for (let round = 0; round < 6; round += 1) {
        for (const target of targets) {
          for (const options of [undefined, { ignoreStartedToday: true }]) {
            const expected = fullScan(app, target, NOW, options)
            seen.add(expected)
            expect(
              readAutomaticCleanupProtection(app, target, NOW, options),
              `seed ${seed} round ${round} ${JSON.stringify(target)} ${JSON.stringify(options)}`
            ).toBe(expected)
          }
        }
        app = mutate(rng, app, targets)
      }
    }
    // Why: guards the property against fixtures that stop producing distinct answers.
    for (const reason of [
      null,
      'protected-workspace',
      'started-today',
      'routine',
      'pinned',
      'saved',
      'protected-session',
      'protection-unknown'
    ]) {
      expect(seen, String(reason)).toContain(reason)
    }
  })

  it('builds the sidebar once per snapshot, however many panes are asked about', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    for (let i = 0; i < 25; i += 1) {
      readAutomaticCleanupProtection(app, i % 2 ? TARGET : { ...TARGET, paneKey: `x${i}` }, NOW)
    }
    expect(build).toHaveBeenCalledTimes(1)
    readAutomaticCleanupProtection(app, TARGET, NOW + 1)
    readAutomaticCleanupProtection({ ...app }, TARGET, NOW + 1)
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('never answers from a stale snapshot after a row changes at the same time', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBeNull()
    useSessionFolders.setState({
      metadata: {
        ...emptySessionFolderMetadata(),
        membership: { [realBuild(app, NOW)[0]!.viewKey]: SAVED_SESSIONS_FOLDER_ID }
      }
    })
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('saved')
    useSessionFolders.setState({ metadata: emptySessionFolderMetadata() })
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBeNull()
    useRoutineConversations.setState({
      byRoutine: {
        legacy: {
          automation: { id: 'legacy' } as Automation,
          sourceTarget: { kind: 'local' },
          tabId: TARGET.tabId,
          paneKey: TARGET.paneKey
        }
      }
    })
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('routine')
    useRoutineConversations.setState({ byRoutine: {} })
    const pinned = { id: 'u', entityId: TARGET.tabId, contentType: 'terminal', isPinned: true }
    const next = { ...app, unifiedTabsByWorktree: { [SESSION_TEST_WORKTREE]: [pinned as never] } }
    expect(readAutomaticCleanupProtection(next, TARGET, NOW)).toBe('pinned')
    const closed = { ...app, tabsByWorktree: { [SESSION_TEST_WORKTREE]: [] } }
    expect(readAutomaticCleanupProtection(closed, TARGET, NOW)).toBe('protection-unknown')
  })

  it('answers with the first of two rows naming the same pane, as the full scan did', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    const row = realBuild(app, NOW).find((entry) => entry.paneKey === TARGET.paneKey)!
    const twins: SessionManageSidebarRow[] = [
      { ...row, pinned: true },
      { ...row, pinned: false }
    ]
    build.mockReturnValue(twins)
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('pinned')
  })
})

describe('Done auto-archive requires an explicit disposable session', () => {
  const metadata = {
    ...emptySessionFolderMetadata(),
    finishActions: {
      'session-done': {
        action: 'end' as const,
        folderId: null,
        afterCompletion: true,
        applied: false
      }
    }
  }
  const view = emptySessionSidebarView()
  const app = { workspaceSessionReady: true, agentStatusByPaneKey: {} } as unknown as AppState
  function doneRow(overrides: Partial<PursuitSidebarTreeRow> = {}): PursuitSidebarTreeRow {
    return {
      session: {
        rowKey: 'row-done',
        sessionKey: 'session-done',
        worktreeId: 'w1',
        hostId: 'local',
        tabId: 'tab-done',
        paneKey: `tab-done:${SESSION_TEST_LEAF}`,
        unavailable: false,
        launchPending: false
      },
      folderId: null,
      attention: null,
      state: null,
      waitingUntil: null,
      completed: { reason: 'finished', at: 10 },
      pursuitState: 'done',
      ...overrides
    } as PursuitSidebarTreeRow
  }
  const revision = (row: PursuitSidebarTreeRow) =>
    sessionDoneArchiveRevision(row, app, metadata, view, true)

  afterEach(() => resetForegroundTerminalTabIdsForTests())

  it('keeps ordinary conversations, whether the answer was read or the tab was never opened', () => {
    for (const unreadCompletion of [false, true]) {
      expect(
        sessionDoneArchiveRevision(
          doneRow({ unreadCompletion }),
          app,
          emptySessionFolderMetadata(),
          view,
          true
        )
      ).toBeNull()
    }
  })

  it('keeps a conversation after its disposable choice is cleared or changed to Keep open', () => {
    for (const finish of [
      { action: 'me' as const, afterCompletion: true },
      { action: 'save' as const, afterCompletion: true },
      { action: 'end' as const }
    ]) {
      expect(
        sessionDoneArchiveRevision(
          doneRow(),
          app,
          { ...metadata, finishActions: { 'session-done': { ...finish, folderId: null } } },
          view,
          true
        )
      ).toBeNull()
    }
  })

  it('allows an explicitly disposable worker never opened in this window to archive after completion', () => {
    expect(revision(doneRow({ unreadCompletion: true }))).not.toBeNull()
    expect(revision(doneRow({ unreadCompletion: true }))).toBe(revision(doneRow()))
  })

  it('still holds an unread completion once its tab has been in front', () => {
    setForegroundTerminalTabIds(['tab-done'])
    setForegroundTerminalTabIds([])
    expect(revision(doneRow({ unreadCompletion: true }))).toBeNull()
    expect(revision(doneRow())).not.toBeNull()
  })

  it('keeps every other hold on a never-shown tab', () => {
    for (const held of [
      doneRow({ unreadCompletion: true, attention: {} as PursuitSidebarTreeRow['attention'] }),
      doneRow({ unreadCompletion: true, planNeedsYou: true } as Partial<PursuitSidebarTreeRow>),
      doneRow({ unreadCompletion: true, waitingUntil: '2026-10-03T00:00:00.000Z' }),
      doneRow({ unreadCompletion: true, backgroundTaskCount: 1 }),
      doneRow({ unreadCompletion: true, archived: true }),
      doneRow({ unreadCompletion: true, pursuitState: 'working' } as Partial<PursuitSidebarTreeRow>)
    ]) {
      expect(revision(held)).toBeNull()
    }
  })
})

describe('archived sessions and the started-today hold (#1214 change b)', () => {
  it('lifts only started-today for archive sleep, keeping every other protection', () => {
    const app = state()
    useRoutineSessionCatalog.getState().replace({ kind: 'local' }, [])
    app.tabsByWorktree[SESSION_TEST_WORKTREE][0].createdAt = NOW - 60_000
    expect(readAutomaticCleanupProtection(app, TARGET, NOW)).toBe('started-today')
    expect(
      readAutomaticCleanupProtection(app, TARGET, NOW, { ignoreStartedToday: true })
    ).toBeNull()
    app.worktreesByRepo['repo-a'][0].path = '/work/email'
    expect(readAutomaticCleanupProtection(app, TARGET, NOW, { ignoreStartedToday: true })).toBe(
      'protected-workspace'
    )
  })

  it('asks for protection without the started-today hold when judging an archived pane', () => {
    const app = state()
    const readProtection = vi.fn(readAutomaticCleanupProtection)
    const session = { kind: 'terminal', hostId: 'local', ...TARGET } as unknown as SidebarSession
    judgeArchivedPane(
      {
        readProtection,
        app: () => app,
        view: () => ({ loaded: true, archived: [] }),
        panes: () => [session],
        host: () => ({ executionHostId: 'local', runtimeEnvironmentId: null }),
        now: () => NOW,
        touch: (_state: AppState, now: number) => ({ now })
      } as unknown as ArchiveSleepDeps,
      TARGET.paneKey
    )
    expect(readProtection).toHaveBeenCalledWith(app, TARGET, NOW, { ignoreStartedToday: true })
  })
})

describe('When finished: End, as --ephemeral arms it (#1214 scheduleFinish and change c)', () => {
  const session = {
    rowKey: 'row-end',
    sessionKey: 'session-end',
    worktreeId: SESSION_TEST_WORKTREE,
    tabId: 'tab-end',
    paneKey: `tab-end:${SESSION_TEST_LEAF}`,
    kind: 'terminal',
    hostId: 'local',
    unavailable: false,
    label: 'Work'
  } as SidebarSession
  const save = vi.fn(async () => true)
  const preference = () => useSessionFolders.getState().metadata.finishActions!['session-end']!
  const apply = () => applyWhenFinished(session, preference(), save)
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value)
    })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSessionFolders.setState({
      loaded: true,
      error: null,
      metadata: emptySessionFolderMetadata()
    })
    finish.read.mockReset()
    finish.close.mockClear()
    finish.busy.mockReturnValue(false)
    save.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  it('closes the tab once the host confirms the work finished and nothing is open', async () => {
    scheduleWhenFinished(session, { action: 'end' })
    expect(preference()).toMatchObject({ action: 'end', afterCompletion: true, applied: false })
    finish.read.mockResolvedValue({ finishReady: false, archiveSleepClear: true })
    await apply()
    expect(finish.close).not.toHaveBeenCalled()
    finish.read.mockResolvedValue({ finishReady: true, archiveSleepClear: true })
    await apply()
    expect(finish.close).toHaveBeenCalledExactlyOnceWith('tab-end', { rejectPinned: true })
    expect(preference().applied).toBe(true)
  })

  it('refuses End while the host reads a question or proposal open, then closes once clear', async () => {
    scheduleWhenFinished(session, { action: 'end' })
    finish.read.mockResolvedValue({ finishReady: true, archiveSleepClear: false })
    await apply()
    await apply()
    expect(finish.close).not.toHaveBeenCalled()
    expect(preference().applied).toBe(false)
    finish.read.mockResolvedValue({ finishReady: true, archiveSleepClear: true })
    await apply()
    expect(finish.close).toHaveBeenCalledOnce()
  })

  it('keeps the earlier End on an older host that does not report the reading', async () => {
    scheduleWhenFinished(session, { action: 'end' })
    finish.read.mockResolvedValue({ finishReady: true })
    await apply()
    expect(finish.close).toHaveBeenCalledOnce()
  })

  it('still files Save while something is open: the new guard is End-only', async () => {
    scheduleWhenFinished(session, { action: 'save', folderId: 'acceptance' })
    finish.read.mockResolvedValue({ finishReady: true, archiveSleepClear: false })
    await apply()
    expect(save).toHaveBeenCalledExactlyOnceWith(session, 'acceptance')
    expect(finish.close).not.toHaveBeenCalled()
  })

  it('leaves the tab open while its agent still runs, whatever the host reads', async () => {
    scheduleWhenFinished(session, { action: 'end' })
    finish.busy.mockReturnValue(true)
    finish.read.mockResolvedValue({ finishReady: true, archiveSleepClear: true })
    await apply()
    expect(finish.read).not.toHaveBeenCalled()
    expect(finish.close).not.toHaveBeenCalled()
  })
})
