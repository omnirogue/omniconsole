import { describe, expect, it, vi } from 'vitest'
import { HostResourceReader, type HostResourceAnswer } from './host-resource-reader'

const OK: HostResourceAnswer = {
  state: 'ok',
  memory: { totalMemory: 32, availableMemory: 12, cpuCoreCount: 10, loadAverage1m: 3 },
  liveSessions: 2
}

function reader(overrides: {
  readRemote?: (key: string) => Promise<HostResourceAnswer>
  now?: () => number
}) {
  const readLocal = vi.fn(async () => OK)
  const readRemote = vi.fn(overrides.readRemote ?? (async () => OK))
  return {
    readLocal,
    readRemote,
    reader: new HostResourceReader({
      readLocal,
      readRemote,
      now: overrides.now ?? (() => 1_000),
      answerWaitMs: 20,
      readTimeoutMs: 40
    })
  }
}

describe('HostResourceReader', () => {
  it('reads the local Mac and remote hosts in one shape, reusing fresh readings', async () => {
    const { reader: r, readLocal, readRemote } = reader({})
    const first = await r.read(['local', 'ssh:mw0002', 'local'])
    expect(first.map((reading) => [reading.hostKey, reading.state])).toEqual([
      ['local', 'ok'],
      ['ssh:mw0002', 'ok']
    ])
    expect(first[1]).toMatchObject({ readAt: 1_000, liveSessions: 2 })
    await r.read(['local', 'ssh:mw0002'])
    expect(readLocal).toHaveBeenCalledTimes(1)
    expect(readRemote).toHaveBeenCalledTimes(1)
  })

  it('turns a failing host into unavailable without holding up the others', async () => {
    const { reader: r } = reader({
      readRemote: async (key) => {
        if (key === 'ssh:down') {
          throw new Error('That SSH host is not connected.')
        }
        return OK
      }
    })
    const readings = await r.read(['ssh:down', 'runtime:up'])
    expect(readings[0]).toMatchObject({
      state: 'unavailable',
      detail: 'That SSH host is not connected.',
      memory: null
    })
    expect(readings[1]).toMatchObject({ state: 'ok' })
  })

  it('answers checking for a slow host, then unavailable once it times out', async () => {
    const { reader: r } = reader({ readRemote: () => new Promise(() => {}) })
    expect((await r.read(['ssh:slow']))[0]).toMatchObject({ state: 'checking', readAt: null })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect((await r.read(['ssh:slow']))[0]).toMatchObject({ state: 'unavailable' })
  })

  it('does not repeat timed-out reads and accepts a late result', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (answer: HostResourceAnswer) => void
      const { reader: r, readRemote } = reader({
        now: Date.now,
        readRemote: () => new Promise((done) => {
          resolve = done
        })
      })
      const first = r.read(['ssh:slow'])
      await vi.advanceTimersByTimeAsync(40)
      await first
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await r.read(['ssh:slow']))[0].state).toBe('unavailable')
      expect(readRemote).toHaveBeenCalledTimes(1)
      resolve(OK)
      await vi.advanceTimersByTimeAsync(0)
      expect((await r.read(['ssh:slow']))[0]).toMatchObject(OK)
      await vi.advanceTimersByTimeAsync(30_000)
      const next = r.read(['ssh:slow'])
      await vi.advanceTimersByTimeAsync(40)
      expect((await next)[0]).toMatchObject(OK)
      expect(readRemote).toHaveBeenCalledTimes(2)
      resolve(OK)
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles synchronous read failures without leaving the host in flight', async () => {
    let now = 1_000
    const { reader: r, readRemote } = reader({
      now: () => now,
      readRemote: () => {
        throw new Error('disconnected')
      }
    })
    expect((await r.read(['ssh:down']))[0]).toMatchObject({ state: 'unavailable' })
    now += 30_000
    await r.read(['ssh:down'])
    expect(readRemote).toHaveBeenCalledTimes(2)
  })
})
