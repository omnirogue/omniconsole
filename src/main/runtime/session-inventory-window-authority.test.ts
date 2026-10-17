import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeMobileSessionSnapshotTab,
  type RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './omni-runtime'
import { resolveWindowPublicationAuthority } from './mobile-session-window-authority'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

// The Mac Studio capture (frames-studio-1005-b.ndjson, 5 Oct 2026): workspace and tab ids verbatim.
const REPO_ID = '323b2cb4-9c16-42db-9870-0f878a953a69'
const REPO_PATH = '/Users/maintainer/Work/Shared/Advertising'
const WT = `${REPO_ID}::${REPO_PATH}`
const RENDERER_EPOCH = 'renderer:2fafc86f-039a-4184-95c1-8057be529e29'
const WINDOW_BROWSER_IDS = [
  '8c26bccb-79fd-4cf3-acd5-2d6e8091e75b',
  '4cf7644b-22b0-4f81-9b1e-ee0a6d4f6b26',
  'c105a4fb-4f1f-4ef9-83b6-e34987e9d7cf'
]
const TERMINAL_TAB_IDS = ['2e03a1a4', '55511cfa', 'd0762c75']
const LEAF = 'leaf'

type Internals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
    worktreeId?: string,
    options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
  ) => Set<string>
}

function persistedSession(options: { serveTab?: boolean } = {}): WorkspaceSessionState {
  const ids = options.serveTab ? [...TERMINAL_TAB_IDS, 'serve-tab'] : TERMINAL_TAB_IDS
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: ids.map((id, index) => ({
        id,
        ptyId: id === 'serve-tab' ? 'serve-runtime-pty' : `pty-${id}`,
        worktreeId: WT,
        title: `Terminal ${index + 1}`,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index
      }))
    }
  }
}

function windowPublication(version: number): RuntimeMobileSessionTabsSnapshot {
  const terminals: RuntimeMobileSessionSnapshotTab[] = TERMINAL_TAB_IDS.map((id, index) => ({
    type: 'terminal',
    id: `${id}::${LEAF}`,
    parentTabId: id,
    leafId: LEAF,
    ptyId: `pty-${id}`,
    title: `Terminal ${index + 1}`,
    isActive: index === 0
  }))
  const browsers: RuntimeMobileSessionSnapshotTab[] = WINDOW_BROWSER_IDS.map((id) => ({
    type: 'browser',
    id,
    title: `Ads dashboard ${id.slice(0, 4)}`,
    browserWorkspaceId: id,
    browserPageId: `page-${id}`,
    url: `https://ads.example/${id.slice(0, 4)}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }))
  const files: RuntimeMobileSessionSnapshotTab[] = ['plan.md', 'spend.csv'].map((name) => ({
    type: 'file',
    id: `file-${name}`,
    title: name,
    filePath: `${REPO_PATH}/${name}`,
    relativePath: name,
    language: 'plaintext',
    isDirty: false,
    isActive: false
  }))
  const tabs = [...terminals, ...browsers, ...files]
  return {
    worktree: WT,
    publicationEpoch: RENDERER_EPOCH,
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: terminals[0]!.id,
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'group',
        activeTabId: TERMINAL_TAB_IDS[0]!,
        tabOrder: [...TERMINAL_TAB_IDS, ...WINDOW_BROWSER_IDS, ...files.map((tab) => tab.id)]
      }
    ],
    tabs
  }
}

function createDesktopRuntime(options: { serveTab?: boolean } = {}): {
  runtime: OrcaRuntimeService
  internals: Internals
} {
  const repo = { id: REPO_ID, path: REPO_PATH }
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: () => persistedSession(options),
    getRepo: () => repo,
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({})
  } as never)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [windowPublication(363)],
    rendererGeneration: RENDERER_EPOCH
  })
  return { runtime, internals: runtime as unknown as Internals }
}

function stored(internals: Internals): RuntimeMobileSessionTabsSnapshot {
  return internals.mobileSessionTabsByWorktree.get(WT)!
}

function browserIds(snapshot: RuntimeMobileSessionTabsSnapshot): string[] {
  return snapshot.tabs.filter((tab) => tab.type === 'browser').map((tab) => tab.id)
}

/** The window's own browser rows; a runtime-owned client page may legitimately join them. */
function windowBrowserIds(snapshot: RuntimeMobileSessionTabsSnapshot): string[] {
  return browserIds(snapshot).filter((id) => WINDOW_BROWSER_IDS.includes(id))
}

/** The renderer's next sync withholds the unchanged workspace, as the capture's syncs did. */
function rendererResync(runtime: OrcaRuntimeService): string[] {
  return (
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [],
      unchangedMobileSessionWorktrees: [WT],
      rendererGeneration: RENDERER_EPOCH
    }).mobileSessionResyncWorktrees ?? []
  )
}

describe('window publication is authoritative for window-owned surfaces (step 3, C2 capture)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [
      'a status touch with the serve browser backend (touchMobileSessionTabsForWorktree)',
      (runtime: OrcaRuntimeService) => {
        runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
        runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
      }
    ],
    [
      'a paired client activating the workspace (activateManagedWorktree hydrate)',
      (_runtime: OrcaRuntimeService, internals: Internals) => {
        internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
          allowAttachedWindow: true
        })
      }
    ],
    [
      'a client-hosted page announcement (notifyMobileSessionTabsChanged)',
      (runtime: OrcaRuntimeService) => {
        const registry = getRuntimeBrowserPageRegistry(runtime)
        registry.publishClientPage({
          browserPageId: `page-client-${registry.listPages(WT).length}`,
          workspaceId: WT,
          browserProfileId: 'profile-a',
          executionHostKey: 'execution-a',
          placement: {
            kind: 'client',
            browserHostClientId: 'macbook',
            browserHostGeneration: 1,
            pageHostGeneration: 1
          },
          url: 'https://remote.internal/',
          title: 'Remote app',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          active: false
        })
        runtime.notifyMobileSessionTabsChanged(WT)
      }
    ]
  ])('keeps the window’s three browser tabs through %s', (_label, trigger) => {
    const { runtime, internals } = createDesktopRuntime()
    const frames: { epoch: string; tabs: number }[] = []
    runtime.onMobileSessionTabsChanged((snapshot) =>
      frames.push({ epoch: snapshot.publicationEpoch, tabs: snapshot.tabs.length })
    )
    expect(windowBrowserIds(stored(internals))).toEqual(WINDOW_BROWSER_IDS)

    // The capture repeated this pair five times in eight minutes; three rounds show it here.
    for (let round = 0; round < 3; round += 1) {
      trigger(runtime, internals)
      // Before the fix: 58 -> 55, the base epoch became headless-hydrated:*, and the next
      // renderer sync asked for a republish that re-added the three tabs (55 -> 57).
      expect(windowBrowserIds(stored(internals))).toEqual(WINDOW_BROWSER_IDS)
      expect(stored(internals).publicationEpoch.startsWith(RENDERER_EPOCH)).toBe(true)
      expect(rendererResync(runtime)).toEqual([])
    }
    expect(frames.every((frame) => frame.epoch.startsWith(RENDERER_EPOCH))).toBe(true)
  })

  it('still lets the window remove its own browser tab, exactly once', () => {
    const { runtime, internals } = createDesktopRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    const closed = windowPublication(364)
    closed.tabs = closed.tabs.filter((tab) => tab.id !== WINDOW_BROWSER_IDS[0])
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [closed],
      rendererGeneration: RENDERER_EPOCH
    })
    expect(browserIds(stored(internals))).toEqual(WINDOW_BROWSER_IDS.slice(1))
    const afterClose = stored(internals)

    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
    // The reconcile neither resurrects the closed tab nor drops the remaining window tabs.
    expect(browserIds(stored(internals))).toEqual(WINDOW_BROWSER_IDS.slice(1))
    expect(stored(internals).snapshotVersion).toBe(afterClose.snapshotVersion + 1)
  })

  it('ends the window\u2019s authority when the window closes', () => {
    const { runtime, internals } = createDesktopRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.markGraphUnavailable(1)
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
    // Its <webview> pages closed with it; the runtime reconciler manages browser rows again.
    expect(browserIds(stored(internals))).toEqual([])
  })

  it('grants authority only to the current renderer generation\u2019s publication', () => {
    const accepted = { publicationEpoch: RENDERER_EPOCH, rendererTabIdentityKeys: new Set(['x']) }
    const snapshot = windowPublication(1)
    const resolve = (rendererGeneration: string | null, authoritativeWindowId: number | null) =>
      resolveWindowPublicationAuthority({
        authoritativeWindowId,
        headlessWindowId: HEADLESS_RUNTIME_WINDOW_ID,
        rendererGeneration,
        accepted,
        snapshot
      })
    expect(resolve(RENDERER_EPOCH, 1)).toBe(accepted)
    expect(resolve('renderer:after-reload', 1)).toBeNull()
    expect(resolve(null, 1)).toBeNull()
    expect(resolve(RENDERER_EPOCH, null)).toBeNull()
    expect(resolve(RENDERER_EPOCH, HEADLESS_RUNTIME_WINDOW_ID)).toBeNull()
  })

  it('keeps replacing runtime-owned browser rows under headless authority (positive control)', () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => persistedSession(),
      getRepo: () => ({ id: REPO_ID, path: REPO_PATH }),
      getRepos: () => [{ id: REPO_ID, path: REPO_PATH }]
    } as never)
    const internals = runtime as unknown as Internals
    let liveTabs = [{ browserPageId: 'offscreen-a', index: 0, url: 'https://a/', title: 'A' }]
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.setAgentBrowserBridge({ tabList: vi.fn(() => ({ tabs: liveTabs })) } as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT)
    expect(browserIds(stored(internals))).toEqual(['offscreen-a'])

    liveTabs = [{ browserPageId: 'offscreen-b', index: 0, url: 'https://b/', title: 'B' }]
    runtime.notifyMobileSessionTabsChanged(WT)
    expect(browserIds(stored(internals))).toEqual(['offscreen-b'])
  })

  it('does not rewrite the window publication when no runtime-owned surface is missing', () => {
    const { runtime, internals } = createDesktopRuntime({ serveTab: true })
    const before = stored(internals)
    // The serve-owned terminal the window does not publish was added (a legitimate runtime add).
    expect(
      before.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(true)
    // The third writer in the capture: hydration merging into the renderer publication on every
    // graph sync and flipping its merge epoch against the renderer merge.
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(stored(internals)).toBe(before)
    expect(rendererResync(runtime)).toEqual([])
    expect(stored(internals)).toBe(before)
  })
})
