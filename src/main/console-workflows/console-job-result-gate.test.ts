import { describe, expect, it, vi } from 'vitest'
import { ConsoleJobResultGate } from './console-job-result-gate'

describe('one terminal result per Dispatch', () => {
  it('waits for in-flight publication before cancellation can inspect the frozen result', async () => {
    const gate = new ConsoleJobResultGate()
    const release = Promise.withResolvers<void>()
    let frozen = false
    const publishing = gate.run('dispatch-a', async () => {
      await release.promise
      frozen = true
    })
    const stop = vi.fn(async () => frozen)
    const cancelling = gate.run('dispatch-a', stop)
    expect(await gate.run('dispatch-b', async () => 'independent')).toBe('independent')
    expect(stop).not.toHaveBeenCalled()
    release.resolve()
    await publishing
    expect(await cancelling).toBe(true)
  })

  it('allows exact stop recovery after an acceptance operation fails', async () => {
    const gate = new ConsoleJobResultGate()
    await expect(
      gate.run('dispatch-a', async () => {
        throw new Error('offline')
      })
    ).rejects.toThrow('offline')
    expect(await gate.run('dispatch-a', async () => 'stop confirmed')).toBe('stop confirmed')
  })
})
