/** Shared setup for the non-host ("caller") session tab activation tests (C3). */
import { vi, type Mock } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { TerminalTabMountOutcome } from '../../shared/terminal-tab-mount-ack'

export const WT = 'wt-1'
export const TAB = 'tab-1'
export const LEAF = '11111111-1111-4111-8111-111111111111'
export const SURFACE = `${TAB}::${LEAF}`
export const WINDOW_ID = 1
/** The daemon form a renderer-owned terminal uses: id shape proves no runtime ownership. */
export const STALE_PTY = `${WT}@@stale-renderer-pty`

type Listener = (...args: unknown[]) => void
type SpawnOpts = { sessionId?: string; afterAgentLaunchAdmission?: () => void }

export type CallerActivationFixture = {
  runtime: OrcaRuntimeService
  spawn: Mock<(opts: SpawnOpts) => Promise<{ id: string }>>
  focusTerminal: Mock
  /** Mount requests the window received. */
  mountRequests: Record<string, unknown>[]
  /** What the fake window answers the next mount request with (null: no answer). */
  setMountOutcome: (outcome: TerminalTabMountOutcome | null) => void
  dropPersistedTab: () => void
  internals: {
    mobileSessionTabsByWorktree: Map<string, { tabs: Record<string, unknown>[] }>
  }
}

function persistedSession(ptyId: string | null, launchAgent?: 'claude') {
  return {
    activeRepoId: null,
    activeWorktreeId: WT,
    activeTabId: TAB,
    activeTabIdByWorktree: { [WT]: TAB },
    tabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          ptyId,
          worktreeId: WT,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ...(launchAgent ? { launchAgent } : {})
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: ptyId ? { [LEAF]: ptyId } : {}
      }
    }
  }
}

export function createCallerActivationFixture(
  options: {
    persistedPtyId?: string | null
    launchAgent?: 'claude'
    /** A sleeping-agent record for the surface: parked by worktree sleep, or a completed turn. */
    hold?: 'parked' | 'completed'
  } = {}
): CallerActivationFixture {
  let session = persistedSession(
    options.persistedPtyId === undefined ? STALE_PTY : options.persistedPtyId,
    options.launchAgent
  )
  if (options.hold) {
    session = {
      ...session,
      sleepingAgentSessionsByPaneKey: {
        [`${TAB}:${LEAF}`]: {
          paneKey: `${TAB}:${LEAF}`,
          tabId: TAB,
          worktreeId: WT,
          agent: 'claude',
          prompt: 'do the thing',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: options.hold === 'parked' ? 'worktree-sleep' : 'live'
        }
      }
    } as typeof session
  }
  const store = {
    getRepo: () => undefined,
    getWorkspaceSession: () => session,
    setWorkspaceSession: vi.fn((next: typeof session) => {
      session = next
    }),
    persistPtyBinding: vi.fn(() => true),
    getSettings: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never)
  vi.spyOn(
    runtime as unknown as { resolveTerminalWorkspaceLaunchScope: () => Promise<unknown> },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: WT,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn: CallerActivationFixture['spawn'] = vi.fn(async (opts: SpawnOpts) => {
    // Why: the real controller calls this once the agent admission gate lets the start through.
    opts.afterAgentLaunchAdmission?.()
    return { id: opts.sessionId ?? 'serve-fresh' }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const focusTerminal = vi.fn()
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal,
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })

  const listeners = new Map<string, Set<Listener>>()
  const mountRequests: Record<string, unknown>[] = []
  let mountOutcome: TerminalTabMountOutcome | null = 'mounted'
  const webContents = {
    send: (channel: string, payload: Record<string, unknown>) => {
      if (channel !== 'terminal:requestTabMount') {
        return
      }
      mountRequests.push(payload)
      if (mountOutcome === null || typeof payload.requestId !== 'string') {
        return
      }
      const reply = { ...payload, outcome: mountOutcome }
      queueMicrotask(() => {
        for (const listener of listeners.get('terminal:tabMountReply') ?? []) {
          listener({ sender: webContents }, reply)
        }
      })
    }
  }
  const win = { isDestroyed: () => false, webContents }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: (id) => (id === WINDOW_ID ? (win as never) : null),
    onIpc: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener as Listener)
      listeners.set(channel, set)
    },
    removeIpcListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener as Listener)
    }
  })

  return {
    runtime,
    spawn,
    focusTerminal,
    mountRequests,
    setMountOutcome: (outcome) => {
      mountOutcome = outcome
    },
    dropPersistedTab: () => {
      session = { ...session, tabsByWorktree: { [WT]: [] } }
    },
    internals: runtime as unknown as CallerActivationFixture['internals']
  }
}

/** The window publishes its own inventory; each entry is a pending (unmounted) terminal. */
export function publishWindowTabs(
  runtime: OrcaRuntimeService,
  surfaces: { tabId: string; leafId: string; ptyId?: string }[],
  epoch = 'renderer:window'
): void {
  runtime.attachWindow(WINDOW_ID)
  runtime.syncWindowGraph(WINDOW_ID, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WT,
        publicationEpoch: epoch,
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: surfaces[0] ? `${surfaces[0].tabId}::${surfaces[0].leafId}` : null,
        activeTabType: surfaces[0] ? 'terminal' : null,
        tabs: surfaces.map((surface, index) => ({
          type: 'terminal' as const,
          id: `${surface.tabId}::${surface.leafId}`,
          parentTabId: surface.tabId,
          leafId: surface.leafId,
          ...(surface.ptyId ? { ptyId: surface.ptyId } : {}),
          title: 'Claude',
          isActive: index === 0
        }))
      }
    ]
  })
}

/** A stored row the window's current publication no longer lists (a stale snapshot). */
export function injectStaleSurface(
  fixture: CallerActivationFixture,
  surface: { tabId: string; leafId: string; ptyId?: string }
): void {
  const stored = fixture.internals.mobileSessionTabsByWorktree.get(WT)!
  fixture.internals.mobileSessionTabsByWorktree.set(WT, {
    ...stored,
    tabs: [
      ...stored.tabs,
      {
        type: 'terminal',
        id: `${surface.tabId}::${surface.leafId}`,
        parentTabId: surface.tabId,
        leafId: surface.leafId,
        ...(surface.ptyId ? { ptyId: surface.ptyId } : {}),
        title: 'Old conversation',
        isActive: false
      }
    ]
  })
}

export const callerActivate = (
  runtime: OrcaRuntimeService,
  tabId = TAB,
  leafId: string | undefined = LEAF,
  intent: 'user' | 'automatic' = 'automatic'
) =>
  runtime.activateMobileSessionTab(`id:${WT}`, tabId, leafId, {
    notifyClients: false,
    navigation: 'caller',
    intent
  })

/** A desktop whose window published and then closed while the app keeps running (macOS). */
export function closeWindowAfterPublishing(runtime: OrcaRuntimeService): void {
  runtime.attachWindow(WINDOW_ID)
  runtime.syncWindowGraph(WINDOW_ID, { tabs: [], leaves: [] })
  runtime.markGraphUnavailable(WINDOW_ID)
}
