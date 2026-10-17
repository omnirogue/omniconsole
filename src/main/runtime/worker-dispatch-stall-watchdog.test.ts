import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  INTERACTIVE_WAIT_READING_FRESH_MS,
  runWorkerDispatchStallWatchdog
} from './worker-dispatch-stall-watchdog'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const TERMINAL_HANDLE = 'term_worker'
const TIMEOUT_MS = 180_000

/** Lets the pane reading the watchdog started settle; no real time passes. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function sqliteUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
}

describe('runWorkerDispatchStallWatchdog', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  /** A dispatch left `ready` with no hook row at all, silent past its own 180 s budget. */
  function silentDispatch(now: number): string {
    const created = (db = new OrchestrationDb(':memory:'))
    const task = created.createTask({ spec: 'step 1' })
    const started = created.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { agent: 'codex', timeoutMs: TIMEOUT_MS }
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
      .run(sqliteUtc(now - TIMEOUT_MS - 1_000), started.dispatch.id)
    return started.dispatch.id
  }

  function runtime(wait: () => Promise<unknown>): OrcaRuntimeService {
    return {
      getOrchestrationDb: () => db!,
      getFreshAgentHookStatusForHandle: () => null,
      getTerminalInteractiveWait: vi.fn(wait),
      listSessionChains: () => [],
      upsertSessionChain: () => undefined
    } as unknown as OrcaRuntimeService
  }

  it('keeps a silent dispatch whose pane shows a prompt only a person may answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const dispatchId = silentDispatch(now)
    const host = runtime(async () => ({
      source: 'prompt-text',
      reason: 'codex-hooks-review-prompt'
    }))

    // The first pass starts the reading and keeps the dispatch; the second has the answer.
    expect(runWorkerDispatchStallWatchdog(host, now)).toBe(0)
    await settled()
    expect(runWorkerDispatchStallWatchdog(host, now + 2_000)).toBe(0)
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    // One reading stands for a while: the pane is not probed on every two-second pass.
    expect(host.getTerminalInteractiveWait).toHaveBeenCalledTimes(1)
  })

  it('fails the silent dispatch one pass later when its pane shows no prompt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const dispatchId = silentDispatch(now)
    const host = runtime(async () => null)

    expect(runWorkerDispatchStallWatchdog(host, now)).toBe(0)
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    await settled()
    expect(runWorkerDispatchStallWatchdog(host, now + 2_000)).toBe(1)
    expect(db!.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'input_accepted_stalled'
    })
  })

  it('treats a pane that cannot be evaluated, or a failed read, as no evidence of a wait', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    silentDispatch(now)
    const host = runtime(async () => {
      throw new Error('pane is gone')
    })
    expect(runWorkerDispatchStallWatchdog(host, now)).toBe(0)
    await settled()
    expect(runWorkerDispatchStallWatchdog(host, now + 2_000)).toBe(1)
  })

  it('reads the pane again once a reading has gone stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const dispatchId = silentDispatch(now)
    let waiting: unknown = { source: 'title' }
    const host = runtime(async () => waiting)

    runWorkerDispatchStallWatchdog(host, now)
    await settled()
    expect(runWorkerDispatchStallWatchdog(host, now + 2_000)).toBe(0)

    // The person answered the prompt and the agent still says nothing: now it IS a stall.
    waiting = null
    const later = now + INTERACTIVE_WAIT_READING_FRESH_MS + 1
    expect(runWorkerDispatchStallWatchdog(host, later)).toBe(0)
    await settled()
    expect(runWorkerDispatchStallWatchdog(host, later + 2_000)).toBe(1)
    expect(db!.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('decides on the recorded budget alone on a host that cannot read panes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    silentDispatch(now)
    const host = {
      getOrchestrationDb: () => db!,
      getFreshAgentHookStatusForHandle: () => null,
      listSessionChains: () => [],
      upsertSessionChain: () => undefined
    } as unknown as OrcaRuntimeService
    expect(runWorkerDispatchStallWatchdog(host, now)).toBe(1)
  })
})
