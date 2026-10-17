import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-session-contracts'
import { SESSION_TAB_UNVERIFIABLE_CODE } from '../../shared/session-tab-activation-refusal'
import { OrcaRuntimeService } from './omni-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { SESSION_TABS_CENSUS_VERIFIED_HOLD_MS } from './session-tabs-census-scope'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LOCAL_WORKTREE = 'repo-local::/local/checkout'
const SSH_WORKTREE = 'repo-ssh::/remote/checkout'
const REPOS = [
  { id: 'repo-local', path: '/local/checkout', executionHostId: 'local' },
  { id: 'repo-ssh', path: '/remote/checkout', connectionId: 'box-1' }
]

type ScopedInternals = {
  listResolvedWorktrees: () => Promise<unknown[]>
  collectAllMobileSessionTabs: () => Promise<unknown>
  refreshMobileSessionPtyInventory: () => Promise<unknown>
  toPublishedMobileSessionTabsResult: (
    snapshot: RuntimeMobileSessionTabsSnapshot
  ) => RuntimeMobileSessionTabsResult | null
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function rendererSnapshot(worktree: string): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:current',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function createRuntime(census: () => Promise<string[]> | string[]): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService({
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id)
  } as never)
  runtime.setPtyController({
    listProcesses: vi.fn(async () => []),
    listProcessesWithHostScope: vi.fn(async () => ({ processes: [], hostIds: await census() }))
  } as never)
  // Why: the census resolves worktrees through git; these fixtures need none.
  vi.spyOn(runtime as unknown as ScopedInternals, 'listResolvedWorktrees').mockResolvedValue([])
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [rendererSnapshot(LOCAL_WORKTREE), rendererSnapshot(SSH_WORKTREE)]
  })
  return runtime
}

function internalsOf(runtime: OrcaRuntimeService): ScopedInternals {
  return runtime as unknown as ScopedInternals
}

function markerOf(runtime: OrcaRuntimeService, worktree: string): true | undefined {
  const internals = internalsOf(runtime)
  return internals.toPublishedMobileSessionTabsResult(
    internals.mobileSessionTabsByWorktree.get(worktree)!
  )?.membershipUnverified
}

function versionOf(runtime: OrcaRuntimeService, worktree: string): number {
  return internalsOf(runtime).mobileSessionTabsByWorktree.get(worktree)!.snapshotVersion
}

afterEach(() => {
  vi.useRealTimers()
  setRuntimeDesktopSurface(null)
})

describe('session-tabs inventory census scoped to the execution host (step 6, C4)', () => {
  it('lets a local omission stay provable while an SSH host is offline, marking only its workspace', async () => {
    const runtime = createRuntime(() => ['local'])

    const inventory = await runtime.listAllMobileSessionTabsInventory()

    expect(inventory.authoritative).toBeUndefined()
    expect(inventory.coverage).toEqual({
      unverifiedRepoIds: ['repo-ssh'],
      unverifiedWorkspaces: []
    })
    const byWorktree = new Map(inventory.snapshots.map((snapshot) => [snapshot.worktree, snapshot]))
    expect(byWorktree.get(LOCAL_WORKTREE)?.membershipUnverified).toBeUndefined()
    expect(byWorktree.get(SSH_WORKTREE)?.membershipUnverified).toBe(true)
  })

  it('never claims complete membership before a census settles, or while one times out', async () => {
    vi.useFakeTimers()
    let hang = false
    const runtime = createRuntime(() => (hang ? new Promise<string[]>(() => {}) : ['local']))
    expect(markerOf(runtime, LOCAL_WORKTREE)).toBe(true)

    await runtime.listAllMobileSessionTabsInventory()
    expect(markerOf(runtime, LOCAL_WORKTREE)).toBeUndefined()

    hang = true
    const timedOut = internalsOf(runtime).refreshMobileSessionPtyInventory()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(timedOut).resolves.toBeNull()
    expect(markerOf(runtime, LOCAL_WORKTREE)).toBe(true)
  })

  it('re-mints a workspace only after its verified verdict holds, so a flapping relay bursts nothing', async () => {
    vi.useFakeTimers()
    let queried = ['local']
    const runtime = createRuntime(() => queried)
    await runtime.listAllMobileSessionTabsInventory()
    const local = versionOf(runtime, LOCAL_WORKTREE)
    const ssh = versionOf(runtime, SSH_WORKTREE)

    // The relay answers, drops, and answers again inside the hold.
    for (const answer of [['local', 'ssh:box-1'], ['local'], ['local', 'ssh:box-1'], ['local']]) {
      queried = answer
      await runtime.listAllMobileSessionTabsInventory()
      await vi.advanceTimersByTimeAsync(SESSION_TABS_CENSUS_VERIFIED_HOLD_MS / 4)
    }
    await vi.advanceTimersByTimeAsync(SESSION_TABS_CENSUS_VERIFIED_HOLD_MS * 2)
    expect(versionOf(runtime, SSH_WORKTREE)).toBe(ssh)
    // Why: the local workspace became verified at the first census and has held ever since.
    expect(versionOf(runtime, LOCAL_WORKTREE)).toBe(local + 1)

    queried = ['local', 'ssh:box-1']
    const inventory = await runtime.listAllMobileSessionTabsInventory()
    expect(inventory.authoritative).toBe(true)
    expect(inventory.snapshots.some((snapshot) => snapshot.membershipUnverified)).toBe(false)
    expect(versionOf(runtime, SSH_WORKTREE)).toBe(ssh)
    await vi.advanceTimersByTimeAsync(SESSION_TABS_CENSUS_VERIFIED_HOLD_MS)
    expect(versionOf(runtime, SSH_WORKTREE)).toBe(ssh + 1)
  })

  it('withholds coverage when the publication epoch changes during the retry', async () => {
    const runtime = createRuntime(() => ['local'])
    await runtime.listAllMobileSessionTabsInventory()
    const internals = internalsOf(runtime)
    const collect = internals.collectAllMobileSessionTabs.bind(runtime)
    let collections = 0
    vi.spyOn(internals, 'collectAllMobileSessionTabs').mockImplementation(async () => {
      collections += 1
      if (collections === 2) {
        // The retry races a renderer reload and republication: a new epoch.
        runtime.markRendererReloading(1)
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [rendererSnapshot(LOCAL_WORKTREE), rendererSnapshot(SSH_WORKTREE)]
        })
      }
      return collect()
    })

    const inventory = await runtime.listAllMobileSessionTabsInventory()

    expect(collections).toBe(2)
    expect(inventory.authoritative).toBeUndefined()
    expect(inventory.coverage).toBeUndefined()
  })

  it('refuses a caller retryably for a missing row on an unasked host, tab_not_found locally', async () => {
    const runtime = createRuntime(() => ['local'])
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: (id) => (id === 1 ? (win as never) : null),
      onIpc: () => {},
      removeIpcListener: () => {}
    })
    await runtime.listAllMobileSessionTabsInventory()

    await expect(
      runtime.rejectMissingSessionTabActivation(`id:${SSH_WORKTREE}`)
    ).rejects.toMatchObject({ code: SESSION_TAB_UNVERIFIABLE_CODE })
    await expect(runtime.rejectMissingSessionTabActivation(`id:${LOCAL_WORKTREE}`)).rejects.toThrow(
      'tab_not_found'
    )
  })
})

describe('the unpublished placeholder through the per-device projection', () => {
  it('reaches a paired device rewritten as none:client-navigation and still marked', async () => {
    const runtime = createRuntime(() => ['local', 'ssh:box-1'])

    const placeholder = await runtime.listMobileSessionTabs(
      'id:repo-local::/never-published',
      'device-1'
    )

    expect(placeholder).toMatchObject({
      publicationEpoch: 'none:client-navigation',
      snapshotVersion: 0,
      tabs: [],
      membershipUnverified: true
    })
  })
})
