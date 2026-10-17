import { describe, expect, it, vi } from 'vitest'
import { RunMailboxPump } from './local-run-mailbox-pump'
import { WorkerUnitRegistry, type WorkerUnitLike } from './build-review-worker-registry'
import type {
  ActiveRun,
  WorkerHostContext,
  WorkerLifecycleContext
} from './build-review-worker-lifecycle'

function unit(role: string): WorkerUnitLike {
  return {
    role,
    choice: { agent: 'codex' },
    status: 'running',
    taskId: `task_${role}`,
    dispatchId: null,
    terminalHandle: `term_${role}`,
    report: null,
    error: null
  }
}

function activeRun(): ActiveRun {
  return {
    abort: new AbortController(),
    pendingAck: null,
    seenMessageIds: new Set(),
    execution: null
  }
}

function host(): WorkerHostContext {
  return {
    coordinatorTerminalHandle: 'term_coord',
    runId: 'run_1',
    log: () => {},
    changed: () => {}
  }
}

function done(id: string, dispatchId: string) {
  return {
    id,
    from_handle: 'agent',
    type: 'worker_done',
    subject: 'done',
    body: 'body',
    payload: JSON.stringify({ dispatchId, outcome: 'succeeded' })
  }
}

describe('RunMailboxPump', () => {
  it('is the only check --wait caller and resolves several workers from one batch', async () => {
    const registry = new WorkerUnitRegistry()
    const [a, b] = [unit('a'), unit('b')]
    registry.bind(a, 'ctx_a')
    registry.bind(b, 'ctx_b')
    const calls: Record<string, unknown>[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, ...params })
      if (method !== 'orchestration.check') {
        return {}
      }
      const waits = calls.filter((entry) => entry.method === 'orchestration.check' && entry.wait)
      if (waits.length === 1) {
        return { deliveryId: 'del_1', messages: [done('m1', 'ctx_a'), done('m2', 'ctx_b')] }
      }
      return { deliveryId: null, messages: [] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const run = activeRun()
    const pump = new RunMailboxPump(ctx, host(), run, registry)
    const waits = Promise.all([registry.waitFor(a), registry.waitFor(b)])
    pump.ensure()
    await waits
    await pump.idle()
    const waiting = calls.filter((entry) => entry.method === 'orchestration.check' && entry.wait)
    expect(waiting).toHaveLength(1)
    expect(a.status).toBe('succeeded')
    expect(b.status).toBe('succeeded')
    expect(run.pendingAck).toBe('del_1')
  })

  it('restarts the wait loop for a worker bound while the previous loop was exiting', async () => {
    const registry = new WorkerUnitRegistry()
    const [a, b] = [unit('a'), unit('b')]
    registry.bind(a, 'ctx_a')
    const call = vi.fn(async (method: string) => {
      if (method !== 'orchestration.check') {
        return {}
      }
      return registry.forDispatch('ctx_b')
        ? { deliveryId: 'del_2', messages: [done('m2', 'ctx_b')] }
        : { deliveryId: 'del_1', messages: [done('m1', 'ctx_a')] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const pump = new RunMailboxPump(ctx, host(), activeRun(), registry)
    const live = registry.live.bind(registry)
    let injected = false
    vi.spyOn(registry, 'live').mockImplementation(() => {
      const current = live()
      if (current.length === 0 && !injected) {
        injected = true
        // The rolling pool starts its next worker after the loop chose to exit, before it cleared.
        queueMicrotask(() => {
          registry.bind(b, 'ctx_b')
          pump.ensure()
        })
      }
      return current
    })
    const waitA = registry.waitFor(a)
    pump.ensure()
    await waitA
    const outcome = await Promise.race([
      registry.waitFor(b).then(() => 'reported'),
      new Promise((resolve) => setTimeout(() => resolve('stranded'), 1_000))
    ])
    expect(outcome).toBe('reported')
    expect(b.status).toBe('succeeded')
  })

  it('acknowledges the previous Delivery by piggyback on the next read', async () => {
    const registry = new WorkerUnitRegistry()
    const [a, b] = [unit('a'), unit('b')]
    registry.bind(a, 'ctx_a')
    registry.bind(b, 'ctx_b')
    let reads = 0
    const acks: (string | undefined)[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'orchestration.check') {
        return {}
      }
      acks.push(params.ack as string | undefined)
      reads += 1
      return reads === 1
        ? { deliveryId: 'del_1', messages: [done('m1', 'ctx_a')] }
        : { deliveryId: 'del_2', messages: [done('m2', 'ctx_b')] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const run = activeRun()
    const pump = new RunMailboxPump(ctx, host(), run, registry)
    const waits = Promise.all([registry.waitFor(a), registry.waitFor(b)])
    pump.ensure()
    await waits
    await pump.idle()
    expect(acks).toEqual([undefined, 'del_1'])
    expect(run.pendingAck).toBe('del_2')
  })

  it('does not fold a replayed batch twice, and probes liveness instead of spinning', async () => {
    const registry = new WorkerUnitRegistry()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    let checks = 0
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.workerShow') {
        return { worker: { state: 'failed', last_error: 'died without reporting' } }
      }
      checks += 1
      // The Delivery replays forever; every message in it has already been seen.
      return { deliveryId: 'del_1', messages: [done('m1', 'ctx_a')] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const run = activeRun()
    run.seenMessageIds.add('m1')
    const pump = new RunMailboxPump(ctx, host(), run, registry)
    pump.ensure()
    await pump.idle()
    expect(a.status).toBe('failed')
    expect(a.error).toBe('died without reporting')
    expect(a.report).toBeNull()
    expect(checks).toBe(1)
  })

  it('fails every awaited worker when the mailbox read throws', async () => {
    const registry = new WorkerUnitRegistry()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    const ctx = {
      call: async () => {
        throw new Error('mailbox refused')
      },
      changed: () => {}
    } as unknown as WorkerLifecycleContext
    const pump = new RunMailboxPump(ctx, host(), activeRun(), registry)
    const wait = registry.waitFor(a)
    pump.ensure()
    await expect(wait).rejects.toThrow('mailbox refused')
  })

  it('exits when no worker is live and restarts for a later batch', async () => {
    const registry = new WorkerUnitRegistry()
    const call = vi.fn(async () => ({ deliveryId: null, messages: [] }))
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const pump = new RunMailboxPump(ctx, host(), activeRun(), registry)
    pump.ensure()
    await pump.idle()
    expect(call).not.toHaveBeenCalled()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    const wait = registry.waitFor(a)
    ;(call as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => ({ deliveryId: 'del_1', messages: [done('m1', 'ctx_a')] })
    )
    pump.ensure()
    await wait
    await pump.idle()
    expect(a.status).toBe('succeeded')
  })
})
