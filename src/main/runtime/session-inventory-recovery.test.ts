import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './omni-runtime'
import { SessionInventoryReconciler } from './session-inventory-recovery'

const WT = 'repo::/worktree'

function persistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: ['saved-a', 'saved-b'].map((id, index) => ({
        id,
        ptyId: null,
        worktreeId: WT,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index
      }))
    }
  }
}

type Deferred = { promise: Promise<unknown[]>; resolve: (value: unknown[]) => void }

function deferred(): Deferred {
  let resolve!: (value: unknown[]) => void
  const promise = new Promise<unknown[]>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createRuntime(listProcesses: () => Promise<unknown[]> = async () => []): {
  runtime: OrcaRuntimeService
  stored: Map<string, RuntimeMobileSessionTabsSnapshot>
} {
  const repo = { id: 'repo', path: '/worktree' }
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: () => persistedSession(),
    getRepo: () => repo,
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({})
  } as never)
  runtime.setPtyController({ listProcesses: vi.fn(listProcesses) } as never)
  const stored = (
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree
  return { runtime, stored }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
}

function authorityEpoch(runtime: OrcaRuntimeService): number | null {
  return (
    runtime as unknown as { getAuthoritativeSessionTabsInventoryEpoch(): number | null }
  ).getAuthoritativeSessionTabsInventoryEpoch()
}

function reconciler(runtime: OrcaRuntimeService): SessionInventoryReconciler {
  return (runtime as unknown as { sessionInventoryReconciler: SessionInventoryReconciler })
    .sessionInventoryReconciler
}

describe('serialized session inventory reconciliation (step 3a)', () => {
  it('runs one reconcile at a time and does not commit one a newer request overtook', async () => {
    const log: string[] = []
    let releaseFirst!: () => void
    const reconciler = new SessionInventoryReconciler(async (run) => {
      const label = run.reasons.join('+')
      log.push(`start:${label}`)
      if (log.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      log.push(`${run.isCurrent() ? 'commit' : 'superseded'}:${label}`)
    })

    const first = reconciler.request('startup')
    await flush()
    const second = reconciler.request('pty-change')
    const third = reconciler.request('transition')
    expect(third).toBe(second)
    expect(reconciler.isSettled()).toBe(false)

    releaseFirst()
    await Promise.all([first, second])
    expect(log).toEqual([
      'start:startup',
      'superseded:startup',
      'start:pty-change+transition',
      'commit:pty-change+transition'
    ])
    expect(reconciler.isSettled()).toBe(true)
  })

  it('lets a reader stop waiting on a reconcile that never settles', async () => {
    const reconciler = new SessionInventoryReconciler(() => new Promise<void>(() => {}))
    void reconciler.request('stuck-census')
    await reconciler.whenSettled(5)
    expect(reconciler.isSettled()).toBe(false)
  })
})

describe('recovery before completeness (step 3a)', () => {
  it('starts recovery before publication and advertises completeness once it settles', async () => {
    const census = deferred()
    const { runtime } = createRuntime(() => census.promise)
    const frames: { worktree: string; tabs: unknown[] }[] = []
    // Startup order (src/main/index.ts): start recovery, publish the headless graph, start RPC.
    runtime.startSessionInventoryRecovery()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    await flush()
    // Nothing waited on recovery, and nothing claims a complete inventory before it settles.
    expect(authorityEpoch(runtime)).toBeNull()
    expect(frames).toEqual([])

    census.resolve([])
    await vi.waitFor(() => expect(authorityEpoch(runtime)).not.toBeNull())
    // What only recovery provides: the persisted inventory announced to a connected client
    // without any client read having repaired it.
    expect(frames.find((frame) => frame.worktree === WT)?.tabs).toHaveLength(2)
  })

  it('never holds startup on a census that never finishes, and never claims completeness', async () => {
    const { runtime } = createRuntime(() => new Promise<unknown[]>(() => {}))
    runtime.startSessionInventoryRecovery()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    // Reaching here is the point: startup (and the RPC server after it) is not held back.
    await flush()
    expect(authorityEpoch(runtime)).toBeNull()
    // A read's wait for recovery is bounded.
    await reconciler(runtime).whenSettled(5)
    expect(reconciler(runtime).isSettled()).toBe(false)
  })

  it('advertises completeness only when the latest run settles, not an overtaken one', async () => {
    const censuses = [deferred(), deferred()]
    let calls = 0
    const { runtime } = createRuntime(() => censuses[Math.min(calls++, 1)]!.promise)
    runtime.startSessionInventoryRecovery()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await flush()
    void runtime.reconcileSessionInventory('second-request')

    censuses[0]!.resolve([])
    // The first run settled (overtaken) and the queued run is now waiting on its own census.
    await vi.waitFor(() => expect(calls).toBe(2))
    await flush()
    expect(authorityEpoch(runtime)).toBeNull()

    censuses[1]!.resolve([])
    await vi.waitFor(() => expect(authorityEpoch(runtime)).not.toBeNull())
  })

  it('withholds completeness after a failed desktop promotion until the headless reconcile settles', async () => {
    let gate: Deferred | null = null
    const { runtime } = createRuntime(() => gate?.promise ?? Promise.resolve([]))
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    await (
      runtime as unknown as { sessionInventoryReconciler: SessionInventoryReconciler }
    ).sessionInventoryReconciler.whenSettled(1_000)

    gate = deferred()
    const census = gate
    const authorityEpoch = (): number | null =>
      (
        runtime as unknown as { getAuthoritativeSessionTabsInventoryEpoch(): number | null }
      ).getAuthoritativeSessionTabsInventoryEpoch()
    runtime.markGraphReloadFailed(1, 'renderer-process-gone')
    // Before step 3 the restored headless graph claimed a complete inventory at once, still
    // holding the departed window's publication.
    expect(authorityEpoch()).toBeNull()
    let settled = false
    const pending = runtime.listAllMobileSessionTabsInventory().then((inventory) => {
      settled = true
      return inventory
    })
    await flush()
    expect(settled).toBe(false)

    gate = null
    census.resolve([])
    const inventory = await pending
    expect(authorityEpoch()).not.toBeNull()
    expect(inventory.authoritative).toBe(true)
    expect(inventory.snapshots.find((snapshot) => snapshot.worktree === WT)?.tabs).toHaveLength(2)
  })
})
