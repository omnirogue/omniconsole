import { join } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  codexHomeProcessLockReleased,
  resolveCodexHomeProcessLockKey,
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  tryWithCodexHomeProcessLock,
  withCodexHomeProcessLock
} from './codex-home-process-lock'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withCodexHomeProcessLock', () => {
  it('serializes runs that share a lock key', async () => {
    const events: string[] = []
    const firstGate = deferred()

    const first = withCodexHomeProcessLock('home-a', async () => {
      events.push('first:start')
      await firstGate.promise
      events.push('first:end')
      return 1
    })
    const second = withCodexHomeProcessLock('home-a', async () => {
      events.push('second:start')
      return 2
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    firstGate.resolve()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs different lock keys concurrently', async () => {
    const events: string[] = []
    const firstGate = deferred()

    const first = withCodexHomeProcessLock('home-a', async () => {
      events.push('a:start')
      await firstGate.promise
    })
    const second = withCodexHomeProcessLock('home-b', async () => {
      events.push('b:start')
    })

    await second
    expect(events).toEqual(['a:start', 'b:start'])
    firstGate.resolve()
    await first
  })

  it('releases the lock after a rejected run', async () => {
    await expect(
      withCodexHomeProcessLock('home-a', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await expect(withCodexHomeProcessLock('home-a', async () => 'after')).resolves.toBe('after')
  })

  it('does not release a running lock based on elapsed time', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const gate = deferred()
      const first = withCodexHomeProcessLock('home-long-running', async () => {
        events.push('first:start')
        await gate.promise
      })
      const second = withCodexHomeProcessLock('home-long-running', async () => {
        events.push('second:start')
      })

      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(events).toEqual(['first:start'])

      gate.resolve()
      await Promise.all([first, second])
      expect(events).toEqual(['first:start', 'second:start'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keys explicit and default host homes consistently', () => {
    const previousCodexHome = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
    try {
      const defaultKey = resolveCodexHomeProcessLockKey(null)
      expect(resolveCodexHomeProcessLockKey(join(homedir(), '.codex'))).toBe(defaultKey)
      expect(resolveCodexHomeProcessLockKeyForSpawnEnv(undefined)).toBe(defaultKey)
      expect(resolveCodexHomeProcessLockKey('/somewhere/else')).not.toBe(defaultKey)
    } finally {
      if (previousCodexHome !== undefined) {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })

  it('keys a stripped child env to the real default home, not ambient CODEX_HOME', () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/nested-omni/managed-home'
    try {
      expect(resolveCodexHomeProcessLockKeyForSpawnEnv({ PATH: process.env.PATH })).toBe(
        resolveCodexHomeProcessLockKey(join(homedir(), '.codex'))
      )
      expect(resolveCodexHomeProcessLockKeyForSpawnEnv(undefined)).toBe(
        resolveCodexHomeProcessLockKey('/nested-omni/managed-home')
      )
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })

  it('keys a WSL UNC probe home and a WSL spawn env to the same lock', () => {
    const probeKey = resolveCodexHomeProcessLockKey('\\\\wsl$\\Ubuntu\\home\\user\\.codex')
    const spawnKey = resolveCodexHomeProcessLockKeyForSpawnEnv(
      { CODEX_HOME: '/home/user/.codex' },
      'Ubuntu'
    )
    expect(spawnKey).toBe(probeKey)
  })

  it('uses the WSL default sentinel when launcher filtering strips an ambient home', () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/host-only/codex-home'
    try {
      const inheritedKey = resolveCodexHomeProcessLockKeyForSpawnEnv(
        { CODEX_HOME: '/host-only/codex-home' },
        'Ubuntu'
      )
      const strippedKey = resolveCodexHomeProcessLockKeyForSpawnEnv({}, 'Ubuntu')
      expect(inheritedKey).toBe(strippedKey)
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })
})

describe('tryWithCodexHomeProcessLock and codexHomeProcessLockReleased', () => {
  it('takes only an idle lock and never waits for a taken one', async () => {
    const gate = deferred()
    const held = tryWithCodexHomeProcessLock('home-try', () => gate.promise.then(() => 'first'))
    expect(held).not.toBeNull()
    const skipped = vi.fn(async () => 'second')
    expect(tryWithCodexHomeProcessLock('home-try', skipped)).toBeNull()
    // Nor does it overtake a caller already queued for the lock.
    const queued = withCodexHomeProcessLock('home-try', async () => 'queued')
    expect(tryWithCodexHomeProcessLock('home-try', skipped)).toBeNull()
    gate.resolve()
    await expect(Promise.all([held, queued])).resolves.toEqual(['first', 'queued'])
    await codexHomeProcessLockReleased('home-try')
    expect(skipped).not.toHaveBeenCalled()
    await expect(tryWithCodexHomeProcessLock('home-try', skipped)).resolves.toBe('second')
  })

  it('reports the release of everyone queued so far without taking the lock', async () => {
    const gate = deferred()
    const events: string[] = []
    const first = withCodexHomeProcessLock('home-released', async () => {
      await gate.promise
      events.push('first:end')
    })
    const released = codexHomeProcessLockReleased('home-released').then(() => {
      events.push('released')
    })
    await Promise.resolve()
    expect(events).toEqual([])
    gate.resolve()
    await Promise.all([first, released])
    expect(events).toEqual(['first:end', 'released'])
    // The waiter took nothing: the lock is idle again.
    await expect(tryWithCodexHomeProcessLock('home-released', async () => 'idle')).resolves.toBe(
      'idle'
    )
    await expect(codexHomeProcessLockReleased('home-idle')).resolves.toBeUndefined()
  })

  it('stops waiting for a release when cancelled, leaving the holder running', async () => {
    const gate = deferred()
    const first = withCodexHomeProcessLock('home-released-cancel', () => gate.promise)
    const controller = new AbortController()
    const waiting = codexHomeProcessLockReleased('home-released-cancel', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    await expect(codexHomeProcessLockReleased('home-idle', controller.signal)).rejects.toThrow(
      'stopped'
    )
    expect(tryWithCodexHomeProcessLock('home-released-cancel', async () => {})).toBeNull()
    gate.resolve()
    await first
  })
})
