import { describe, expect, it } from 'vitest'
import { createArtifactLifecycleGate } from './artifact-lifecycle-gate'

describe('artifact lifecycle gate', () => {
  it('keeps every caller together under the cap and hands freed slots to waiters in order', async () => {
    const gate = createArtifactLifecycleGate(4)
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    const order: number[] = []
    const task = (id: number) => () =>
      new Promise<number>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        order.push(id)
        releases.push(() => {
          inFlight -= 1
          resolve(id)
        })
      })
    // Two independent batches of four, as a bulk undo followed by a new bulk action would send.
    const all = Array.from({ length: 8 }, (_, id) => gate.run(task(id)))
    await Promise.resolve()
    expect(inFlight).toBe(4)
    releases.shift()?.()
    // A late caller must not overtake the four already waiting.
    const late = gate.run(task(99))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual([0, 1, 2, 3, 4])
    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all([...all, late])
    expect(peak).toBe(4)
    expect(order.at(-1)).toBe(99)
  })

  it('frees the slot when a task fails', async () => {
    const gate = createArtifactLifecycleGate(1)
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.run(() => Promise.resolve('next'))).resolves.toBe('next')
  })
})
