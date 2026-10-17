import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentLaunchAdmission,
  resolveLaunchAdmissionPer10s,
  type AgentLaunchAdmission,
  type AgentLaunchPriority
} from './agent-launch-admission'

function fakeClock() {
  return {
    now: () => Date.now(),
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

describe('agent launch admission', () => {
  let admission: AgentLaunchAdmission
  let limit: number
  let admittedOrder: string[]
  let admittedAtMs: Map<string, number>

  function enqueue(
    id: string,
    priority: AgentLaunchPriority = 'background',
    isCancelled?: () => boolean
  ) {
    const started = Date.now()
    void admission
      .admit({ priority, getLimit: () => limit, key: id, ...(isCancelled ? { isCancelled } : {}) })
      .then((admitted) => {
        if (admitted) {
          admittedOrder.push(id)
          admittedAtMs.set(id, Date.now() - started)
        }
      })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    admission = createAgentLaunchAdmission({ clock: fakeClock() })
    limit = 3
    admittedOrder = []
    admittedAtMs = new Map()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues 51 background starts into FIFO bursts of 3 per rolling 10 seconds', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `pane-${index}`)
    for (const id of ids) {
      enqueue(id)
    }
    await settle()
    expect(admittedOrder).toEqual(ids.slice(0, 3))

    const burstStarts: number[] = [0]
    for (let burst = 1; burst < 17; burst += 1) {
      await vi.advanceTimersByTimeAsync(9_999)
      expect(admittedOrder).toHaveLength(burst * 3)
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(admittedOrder).toHaveLength(burst * 3 + 3)
      burstStarts.push(Date.now())
    }
    expect(admittedOrder).toEqual(ids)
    expect(burstStarts.at(-1)).toBe(160_000)
    expect(admittedAtMs.get('pane-50')).toBe(160_000)
    // No 10-second window ever holds more than 3 admissions.
    const times = ids.map((id) => admittedAtMs.get(id) ?? -1).sort((a, b) => a - b)
    for (let i = 3; i < times.length; i += 1) {
      expect(times[i] - times[i - 3]).toBeGreaterThanOrEqual(10_000)
    }
    expect(admission.snapshot().queued).toBe(0)
  })

  it('lets a clicked start jump the background queue while still using a slot', async () => {
    for (let index = 0; index < 8; index += 1) {
      enqueue(`bg-${index}`)
    }
    await settle()
    expect(admittedOrder).toEqual(['bg-0', 'bg-1', 'bg-2'])

    await vi.advanceTimersByTimeAsync(1_000)
    enqueue('click-a', 'person')
    enqueue('click-b', 'person')
    await settle()
    // The window is still full: the click waits for the next free slot, not past the cap.
    expect(admittedOrder).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(9_000)
    await settle()
    // Both clicks go first, in their own order, and together use 2 of the 3 slots.
    expect(admittedOrder).toEqual(['bg-0', 'bg-1', 'bg-2', 'click-a', 'click-b', 'bg-3'])
  })

  it('promotes a queued background start when a person reveals its pane (no ~170 s wait)', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `pane-${index}`)
    for (const id of ids) {
      enqueue(id)
    }
    await settle()
    expect(admittedOrder).toEqual(ids.slice(0, 3))

    // The person opens the tab whose start is 48th in line.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(admission.promote('pane-47')).toBe(true)
    await vi.advanceTimersByTimeAsync(8_000)
    await settle()
    // Admitted in the very next slot (10 s after the burst), not after 15 more bursts.
    expect(admittedOrder.slice(3)).toEqual(['pane-47', 'pane-3', 'pane-4'])
    expect(admittedAtMs.get('pane-47')).toBe(10_000)
    // Nothing is promoted twice, and an unknown or already admitted key is a no-op.
    expect(admission.promote('pane-47')).toBe(false)
    expect(admission.promote('pane-0')).toBe(false)
    expect(admission.promote('nope')).toBe(false)
  })

  it('keeps promoted starts FIFO behind earlier person starts', async () => {
    for (let index = 0; index < 6; index += 1) {
      enqueue(`bg-${index}`)
    }
    await settle()
    enqueue('click', 'person')
    expect(admission.promote('bg-5')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(admittedOrder).toEqual(['bg-0', 'bg-1', 'bg-2', 'click', 'bg-5', 'bg-3'])
  })

  it('serves CLI and orchestration starts (explicit lane) ahead of a restore backlog, behind people', async () => {
    // After a restart 30 mid-task agents auto-continue in the background lane (~100 s to drain).
    for (let index = 0; index < 30; index += 1) {
      enqueue(`bg-${index}`)
    }
    await settle()
    expect(admittedOrder).toEqual(['bg-0', 'bg-1', 'bg-2'])
    // An orchestrator fans out 4 workers, then Sal opens a tab.
    for (let index = 0; index < 4; index += 1) {
      enqueue(`worker-${index}`, 'explicit')
    }
    enqueue('reveal', 'person')
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(admittedOrder.slice(3)).toEqual(['reveal', 'worker-0', 'worker-1'])
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(admittedOrder.slice(6)).toEqual(['worker-2', 'worker-3', 'bg-3'])
    // Every worker started within 20 s instead of after the whole ~100 s backlog.
    expect(admittedAtMs.get('worker-3')).toBe(20_000)
    // A reveal promotes an explicit start too.
    enqueue('worker-late', 'explicit')
    expect(admission.promote('worker-late')).toBe(true)
  })

  it('tells a caller when its start has to wait, and only then', async () => {
    const queuedHooks: string[] = []
    const admitWithHook = (id: string): void => {
      void admission.admit({
        priority: 'explicit',
        getLimit: () => limit,
        key: id,
        onQueued: () => queuedHooks.push(id)
      })
    }
    for (let index = 0; index < 5; index += 1) {
      admitWithHook(`pane-${index}`)
    }
    await settle()
    expect(queuedHooks).toEqual(['pane-3', 'pane-4'])
  })

  it('admits everything at once when the limit is 0 (unlimited)', async () => {
    limit = 0
    for (let index = 0; index < 20; index += 1) {
      enqueue(`pane-${index}`)
    }
    await settle()
    expect(admittedOrder).toHaveLength(20)
  })

  it('applies a raised limit at the next drain without a restart', async () => {
    for (let index = 0; index < 12; index += 1) {
      enqueue(`pane-${index}`)
    }
    await settle()
    expect(admittedOrder).toHaveLength(3)
    limit = 10
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(admittedOrder).toHaveLength(12)
  })

  it('drops a cancelled queued start without spending a slot', async () => {
    let cancelled = false
    for (let index = 0; index < 3; index += 1) {
      enqueue(`pane-${index}`)
    }
    enqueue('gone', 'background', () => cancelled)
    enqueue('pane-3')
    enqueue('pane-4')
    enqueue('pane-5')
    enqueue('pane-6')
    await settle()
    cancelled = true
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(admittedOrder).toEqual(['pane-0', 'pane-1', 'pane-2', 'pane-3', 'pane-4', 'pane-5'])
  })

  it('drops a start cancelled deep in the backlog at the next recheck, not when it reaches the head', async () => {
    const cancelled = new Set<string>()
    for (let index = 0; index < 9; index += 1) {
      const id = `pane-${index}`
      enqueue(id, 'background', () => cancelled.has(id))
    }
    await settle()
    expect(admission.snapshot().queued).toBe(6)
    // Its pane closes while it is 7th in line.
    cancelled.add('pane-8')
    admission.recheck()
    await settle()
    expect(admission.snapshot().queued).toBe(5)
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(admittedOrder).toEqual(Array.from({ length: 8 }, (_, index) => `pane-${index}`))
  })

  it('reports a pane start as pending while queued and for one window after admission', async () => {
    for (let index = 0; index < 4; index += 1) {
      enqueue(`pane-${index}`)
    }
    await settle()
    expect(admission.isPending('pane-3')).toBe(true)
    expect(admission.isPending('pane-0')).toBe(true)
    expect(admission.isPending('pane-9')).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    // pane-3 was just admitted: its spawn may still be running.
    expect(admittedOrder).toContain('pane-3')
    expect(admission.isPending('pane-3')).toBe(true)
    expect(admission.isPending('pane-0')).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(admission.isPending('pane-3')).toBe(false)
  })

  it('clamps the setting and falls back to 3', () => {
    expect(resolveLaunchAdmissionPer10s(undefined)).toBe(3)
    expect(resolveLaunchAdmissionPer10s({})).toBe(3)
    expect(resolveLaunchAdmissionPer10s({ launchAdmissionPer10s: Number.NaN })).toBe(3)
    expect(resolveLaunchAdmissionPer10s({ launchAdmissionPer10s: -2 })).toBe(3)
    expect(resolveLaunchAdmissionPer10s({ launchAdmissionPer10s: 0 })).toBe(0)
    expect(resolveLaunchAdmissionPer10s({ launchAdmissionPer10s: 4.7 })).toBe(4)
    expect(resolveLaunchAdmissionPer10s({ launchAdmissionPer10s: 900 })).toBe(50)
  })
})
