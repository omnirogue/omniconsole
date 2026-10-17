import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { SessionChain } from '../../shared/session-chain-types'
import { sweepWorkerDispatchStalls } from './worker-dispatch-stall-sweep'
import type { WorkerDispatchStallObservation } from './orchestration/worker-dispatch-stall-verdict'

// The recorded failure this reproduces: dispatch ctx_… left state=ready, stage=input_accepted,
// last_error=NULL with timeoutMs 180000 stored on it, its task still `dispatched`, and the chain
// step still `queued` — because the agent died on a quota wall and nothing enforced the timeout.
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const TERMINAL_HANDLE = 'term_worker'
const TIMEOUT_MS = 180_000
const QUOTA_WALL =
  "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models."

function sqliteUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
}

function chainWithLaunchedStep(): SessionChain {
  return {
    id: 'chn_5b6976342e68',
    workspacePath: '/work',
    worktreeId: 'repo::worktree',
    hostId: null,
    sourcePaneKey: 'tab-0:00000000-0000-4000-8000-000000000000',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 1,
    state: 'waiting',
    error: null,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'step_1',
        agent: 'claude',
        prompt: 'write the plan',
        status: 'launched',
        launchedPaneKey: PANE_KEY,
        launchedAt: 1
      },
      { id: 'step_2', agent: 'claude', prompt: 'review the plan', status: 'queued' }
    ]
  }
}

describe('sweepWorkerDispatchStalls', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function readyDispatch(args: { updatedAtMs: number; timeoutMs?: number | null }): string {
    const created = (db = db ?? new OrchestrationDb(':memory:'))
    const task = created.createTask({ spec: 'step 1' })
    const started = created.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {
        agent: 'claude',
        ...(args.timeoutMs === null ? {} : { timeoutMs: args.timeoutMs ?? TIMEOUT_MS })
      }
    })
    created.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: TERMINAL_HANDLE }]
    })
    created.markWorkerDispatchReady(started.dispatch.id)
    created.db
      .prepare('UPDATE worker_dispatches SET updated_at = ? WHERE dispatch_id = ?')
      .run(sqliteUtc(args.updatedAtMs), started.dispatch.id)
    return started.dispatch.id
  }

  function deps(args: { chains?: SessionChain[]; observation?: WorkerDispatchStallObservation }): {
    saved: SessionChain[]
    deps: Parameters<typeof sweepWorkerDispatchStalls>[0]
  } {
    const saved: SessionChain[] = []
    let chains = args.chains ?? []
    return {
      saved,
      deps: {
        listWatchedWorkerDispatches: () => db!.listWatchedWorkerDispatches(),
        failReadyWorkerDispatch: (params) => db!.failReadyWorkerDispatch(params),
        observeAgentTurn: () => args.observation ?? null,
        listSessionChains: () => chains,
        upsertSessionChain: (chain) => {
          saved.push(chain)
          chains = chains.map((entry) => (entry.id === chain.id ? chain : entry))
          return chain
        }
      }
    }
  }

  it('fails a dispatch past its recorded timeout, with a readable last_error', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 1_000 })
    const harness = deps({})
    const settled = sweepWorkerDispatchStalls(harness.deps, now)
    expect(settled).toHaveLength(1)
    const worker = db!.getWorkerDispatch(dispatchId)
    expect(worker?.state).toBe('failed')
    expect(worker?.last_error).toContain('No activity was observed for 180s')
    expect(db!.getDispatchContextById(dispatchId)?.status).toBe('failed')
    expect(db!.getTask(db!.getDispatchContextById(dispatchId)!.task_id)?.status).toBe('failed')
  })

  it('counts the worker heartbeat stored on its dispatch as activity', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 60_000 })
    db!.db
      .prepare('UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ?')
      .run(new Date(now - 30_000).toISOString(), dispatchId)
    expect(db!.listWatchedWorkerDispatches()[0]?.last_heartbeat_at).toBe(
      new Date(now - 30_000).toISOString()
    )
    expect(sweepWorkerDispatchStalls(deps({}).deps, now)).toEqual([])
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('does not fail a worker on its first sweep after a runtime restart', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 60_000 })
    db!.db
      .prepare('UPDATE worker_dispatches SET runtime_epoch = ? WHERE dispatch_id = ?')
      .run('runtime-before-restart', dispatchId)
    const harness = deps({})
    const restarted = {
      ...harness.deps,
      runtime: { epoch: 'runtime-after-restart', startedAtMs: now - 1_000 }
    }
    expect(sweepWorkerDispatchStalls(restarted, now)).toEqual([])
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(db!.getDispatchContextById(dispatchId)?.capability_revoked_at).toBeNull()
  })

  it('still fails a silent worker started by this same runtime', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 60_000 })
    db!.db
      .prepare('UPDATE worker_dispatches SET runtime_epoch = ? WHERE dispatch_id = ?')
      .run('this-runtime', dispatchId)
    const harness = deps({})
    const same = { ...harness.deps, runtime: { epoch: 'this-runtime', startedAtMs: now - 1_000 } }
    expect(sweepWorkerDispatchStalls(same, now)).toHaveLength(1)
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('leaves a dispatch that is still inside its budget alone', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - 5_000 })
    expect(sweepWorkerDispatchStalls(deps({}).deps, now)).toEqual([])
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('leaves a working agent alone even long past the budget', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - 60 * 60_000 })
    const settled = sweepWorkerDispatchStalls(
      deps({ observation: { state: 'working', updatedAt: now - 30 * 60_000 } }).deps,
      now
    )
    expect(settled).toEqual([])
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('fails the joined chain step and fills the chain error from a reported turn failure', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - 9_000 })
    const harness = deps({
      chains: [chainWithLaunchedStep()],
      observation: {
        state: 'done',
        failed: true,
        failureReason: QUOTA_WALL,
        updatedAt: now - 1_000
      }
    })
    const settled = sweepWorkerDispatchStalls(harness.deps, now)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.chainIds).toEqual(['chn_5b6976342e68'])
    expect(db!.getWorkerDispatch(dispatchId)?.last_error).toContain('out of usage credits')
    const chain = harness.saved.at(-1)!
    expect(chain.state).toBe('failed')
    expect(chain.error).toContain('out of usage credits')
    expect(chain.steps[0]).toMatchObject({ id: 'step_1', status: 'failed' })
    expect(chain.steps[1]).toMatchObject({ id: 'step_2', status: 'queued' })
  })

  it('does not touch outcome-bound chains, whose record its owner holds behind a fence', () => {
    const now = Date.now()
    readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 1_000 })
    const outcomeChain = {
      ...chainWithLaunchedStep(),
      outcomeSet: { schemaVersion: 1 } as unknown as SessionChain['outcomeSet']
    }
    const harness = deps({ chains: [outcomeChain] })
    const settled = sweepWorkerDispatchStalls(harness.deps, now)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.chainIds).toEqual([])
    expect(harness.saved).toEqual([])
  })

  it('never fails a dispatch whose worker-start recorded no timeout', () => {
    const now = Date.now()
    const dispatchId = readyDispatch({ updatedAtMs: now - 24 * 60 * 60_000, timeoutMs: null })
    expect(sweepWorkerDispatchStalls(deps({}).deps, now)).toEqual([])
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  describe('a pane visibly parked on an interactive prompt', () => {
    it('keeps the dispatch, and reads the pane only when silence alone would fail it', () => {
      const now = Date.now()
      const quiet = readyDispatch({ updatedAtMs: now - 5_000 })
      const asked: string[] = []
      const harness = deps({})
      const observeInteractiveWait = (handle: string) => {
        asked.push(handle)
        return 'waiting' as const
      }
      expect(sweepWorkerDispatchStalls({ ...harness.deps, observeInteractiveWait }, now)).toEqual(
        []
      )
      // Inside its budget nothing is about to fail, so the screen is not read at all.
      expect(asked).toEqual([])

      db!.db
        .prepare('UPDATE worker_dispatches SET updated_at = ? WHERE dispatch_id = ?')
        .run(sqliteUtc(now - TIMEOUT_MS - 1_000), quiet)
      expect(sweepWorkerDispatchStalls({ ...harness.deps, observeInteractiveWait }, now)).toEqual(
        []
      )
      expect(asked).toEqual([TERMINAL_HANDLE])
      expect(db!.getWorkerDispatch(quiet)?.state).toBe('ready')
    })

    it('waits one pass for the reading, then fails the dispatch when no prompt is showing', () => {
      const now = Date.now()
      const dispatchId = readyDispatch({ updatedAtMs: now - TIMEOUT_MS - 1_000 })
      const harness = deps({})
      expect(
        sweepWorkerDispatchStalls({ ...harness.deps, observeInteractiveWait: () => 'pending' }, now)
      ).toEqual([])
      expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')

      const settled = sweepWorkerDispatchStalls(
        { ...harness.deps, observeInteractiveWait: () => 'none' },
        now
      )
      expect(settled).toHaveLength(1)
      expect(db!.getWorkerDispatch(dispatchId)).toMatchObject({
        state: 'failed',
        stage: 'input_accepted_stalled'
      })
    })

    it('never holds back a turn the agent itself reported dead', () => {
      const now = Date.now()
      const dispatchId = readyDispatch({ updatedAtMs: now - 9_000 })
      const harness = deps({
        observation: {
          state: 'done',
          failed: true,
          failureReason: QUOTA_WALL,
          updatedAt: now - 1_000
        }
      })
      const observeInteractiveWait = (): 'waiting' => {
        throw new Error('the screen must not be read for a reported failure')
      }
      expect(
        sweepWorkerDispatchStalls({ ...harness.deps, observeInteractiveWait }, now)
      ).toHaveLength(1)
      expect(db!.getWorkerDispatch(dispatchId)?.stage).toBe('input_accepted_agent_failed')
    })
  })
})
