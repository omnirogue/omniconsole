import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import type { AppState } from '../store/types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const LEAF = '11111111-1111-4111-8111-111111111111'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

function terminal(worktreeId: string, id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unified(worktreeId: string, entityId: string, executionHostId?: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId: 'group-1',
    worktreeId,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(executionHostId ? { executionHostId } : {})
  } as Tab
}

function file(worktreeId: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filePath: id,
    relativePath: id.split('/').pop() ?? id,
    worktreeId,
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    ...extra
  } as AppState['openFiles'][number]
}

function published(state: AppState, worktreeId: string): string[] | undefined {
  return buildMobileSessionTabSnapshots(state)
    .find((snapshot) => snapshot.worktree === worktreeId)
    ?.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
    .sort()
}

function withLayouts(...ids: string[]): AppState['terminalLayoutsByTabId'] {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    ])
  ) as AppState['terminalLayoutsByTabId']
}

describe('desktop session inventory publication ownership', () => {
  it('publishes a local workspace without an explicit host (positive control)', () => {
    const wt = 'local-repo::/local'
    const state = makeState({
      repos: [{ id: 'local-repo' }] as unknown as AppState['repos'],
      tabsByWorktree: { [wt]: [terminal(wt, 'local-tab', 'daemon-pty-1')] },
      terminalLayoutsByTabId: withLayouts('local-tab'),
      openFiles: [file(wt, '/local/notes.md')]
    })
    expect(published(state, wt)).toEqual(['/local/notes.md', 'local-tab'])
  })

  it('publishes a folder workspace and legacy rows without metadata (positive controls)', () => {
    const folder = 'folder:own-folder'
    const legacy = 'gone-repo::/does/not/exist/here'
    const state = makeState({
      folderWorkspaces: [{ id: 'own-folder' }] as unknown as AppState['folderWorkspaces'],
      tabsByWorktree: {
        [folder]: [terminal(folder, 'folder-tab', 'daemon-pty-2')],
        [legacy]: [terminal(legacy, 'legacy-tab', null)]
      },
      terminalLayoutsByTabId: withLayouts('folder-tab', 'legacy-tab')
    })
    expect(published(state, folder)).toEqual(['folder-tab'])
    // Why: a missing repo record or a path that does not exist here is not foreign evidence.
    expect(published(state, legacy)).toEqual(['legacy-tab'])
  })

  it('publishes direct-SSH sessions with their execution host (positive control)', () => {
    const wt = 'ssh-repo::/remote/project'
    const state = makeState({
      repos: [{ id: 'ssh-repo', connectionId: 'studio-ssh' }] as unknown as AppState['repos'],
      tabsByWorktree: { [wt]: [terminal(wt, 'ssh-tab', 'ssh:studio-ssh@@shell-1')] },
      terminalLayoutsByTabId: withLayouts('ssh-tab'),
      unifiedTabsByWorktree: { [wt]: [unified(wt, 'ssh-tab', 'ssh:studio-ssh')] }
    })
    expect(published(state, wt)).toEqual(['ssh-tab'])
  })

  it('never republishes an explicitly peer-owned workspace (negative control)', () => {
    const wt = '323b2cb4::/Users/maintainer/Work/Shared/Advertising'
    const state = makeState({
      repos: [
        { id: '323b2cb4', executionHostId: 'runtime:studio' }
      ] as unknown as AppState['repos'],
      tabsByWorktree: { [wt]: [terminal(wt, 'studio-tab', null)] },
      openFiles: [file(wt, '/Users/maintainer/Work/Shared/Advertising/a.mp4')]
    })
    expect(published(state, wt)).toBeUndefined()
  })

  it('drops per-tab peer provenance inside a local workspace (negative control)', () => {
    const wt = 'local-repo::/mixed'
    const webMirror = toWebTerminalSurfaceTabId('studio-host-tab')
    const state = makeState({
      repos: [{ id: 'local-repo', executionHostId: 'local' }] as unknown as AppState['repos'],
      tabsByWorktree: {
        [wt]: [
          terminal(wt, 'own-tab', 'daemon-pty-3'),
          terminal(wt, 'stamped-peer-tab', null),
          terminal(wt, webMirror, 'remote:studio@@handle-1'),
          terminal(wt, 'remote-pty-tab', 'remote:laptop@@handle-2')
        ]
      },
      terminalLayoutsByTabId: withLayouts(
        'own-tab',
        'stamped-peer-tab',
        webMirror,
        'remote-pty-tab'
      ),
      unifiedTabsByWorktree: { [wt]: [unified(wt, 'stamped-peer-tab', 'runtime:studio')] },
      openFiles: [
        file(wt, '/mixed/own.md'),
        file(wt, '/mixed/peer.md', {
          mirroredFromRuntimeSession: true,
          runtimeEnvironmentId: 'macbook'
        })
      ]
    })
    expect(published(state, wt)).toEqual(['/mixed/own.md', 'own-tab'])
  })

  it('quarantines conflicting provenance: kept locally, never republished', () => {
    const wt = 'local-repo::/conflict'
    const state = makeState({
      repos: [{ id: 'local-repo' }] as unknown as AppState['repos'],
      tabsByWorktree: { [wt]: [terminal(wt, 'conflict-tab', 'daemon-pty-4')] },
      terminalLayoutsByTabId: withLayouts('conflict-tab'),
      unifiedTabsByWorktree: { [wt]: [unified(wt, 'conflict-tab', 'runtime:studio')] }
    })
    expect(published(state, wt) ?? []).toEqual([])
    expect(state.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual(['conflict-tab'])
  })

  it('publishes only positively local tabs from a workspace with conflicting catalog owners', () => {
    const wt = 'shared-repo::/shared'
    const state = makeState({
      repos: [
        { id: 'shared-repo', executionHostId: 'local' },
        { id: 'shared-repo', executionHostId: 'runtime:studio' }
      ] as unknown as AppState['repos'],
      tabsByWorktree: {
        [wt]: [terminal(wt, 'local-pty-tab', 'daemon-pty-5'), terminal(wt, 'no-evidence-tab', null)]
      },
      terminalLayoutsByTabId: withLayouts('local-pty-tab', 'no-evidence-tab')
    })
    expect(published(state, wt)).toEqual(['local-pty-tab'])
  })

  it('reads a host recorded on the worktree before the repo-level host list, as the runtime does', () => {
    const wt = 'shared-repo::/recorded'
    const state = makeState({
      repos: [
        { id: 'shared-repo', executionHostId: 'local' },
        { id: 'shared-repo', executionHostId: 'runtime:studio' }
      ] as unknown as AppState['repos'],
      worktreesByRepo: {
        'shared-repo': [{ id: wt, repoId: 'shared-repo', hostId: 'local' }]
      } as unknown as AppState['worktreesByRepo'],
      tabsByWorktree: { [wt]: [terminal(wt, 'no-evidence-tab', null)] },
      terminalLayoutsByTabId: withLayouts('no-evidence-tab')
    })
    expect(published(state, wt)).toEqual(['no-evidence-tab'])
  })

  it('keeps publishing a local workspace while a paired copy of it is open', () => {
    // Why: the open route is navigation, not ownership; local rows stay this computer's.
    const wt = 'local-repo::/open-elsewhere'
    const state = makeState({
      repos: [{ id: 'local-repo' }] as unknown as AppState['repos'],
      activeWorktreeId: wt,
      activeWorkspaceExecutionHostId: 'runtime:studio',
      tabsByWorktree: { [wt]: [terminal(wt, 'local-tab', 'daemon-pty-9')] },
      terminalLayoutsByTabId: withLayouts('local-tab')
    } as Partial<AppState>)
    expect(published(state, wt)).toEqual(['local-tab'])
  })

  it("drops E3's echoed editors from the owner's own folder workspace", () => {
    // Shape from e3-studio.json: the Studio's Work folder held each open file several times under
    // editor ids minted by paired computers (972fd136…, 550d5f62…) next to its own terminals.
    const folder = 'folder:597c3c95-3a92-449f-9a6d-c0b49eab8106'
    const filePath = '/Users/maintainer/Desktop/OMNIIDE-Overnight.md'
    const echoTabId = `editor:${encodeURIComponent(folder)}:972fd136-6939-4e77-a263-421e9d3f6ad7:${encodeURIComponent(filePath)}`
    const state = makeState({
      folderWorkspaces: [
        { id: '597c3c95-3a92-449f-9a6d-c0b49eab8106' }
      ] as unknown as AppState['folderWorkspaces'],
      tabsByWorktree: { [folder]: [terminal(folder, 'studio-own-tab', 'daemon-pty-6')] },
      terminalLayoutsByTabId: withLayouts('studio-own-tab'),
      unifiedTabsByWorktree: {
        [folder]: [
          {
            ...unified(folder, filePath, 'runtime:macbook-pairing'),
            id: echoTabId,
            contentType: 'editor'
          } as Tab
        ]
      },
      openFiles: [
        file(folder, filePath, {
          mirroredFromRuntimeSession: true,
          runtimeEnvironmentId: 'macbook-pairing'
        })
      ]
    })
    expect(published(state, folder)).toEqual(['studio-own-tab'])
  })
})
