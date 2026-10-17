import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { getDaemonSocketPath } from './daemon-spawner'

it('recovers a refused spawn while retaining uncertainty for concurrently dispatched siblings', async () => {
  const concurrentSpawnCount = 70
  const dir = mkdtempSync(join(tmpdir(), 'daemon-concurrent-recovery-test-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const allPreparationsEntered = Promise.withResolvers<void>()
  const releaseHeldPreparations = Promise.withResolvers<void>()
  const spawnedSessionIds: string[] = []
  let preparationCount = 0

  const spawnSubprocess: ConstructorParameters<typeof DaemonServer>[0]['spawnSubprocess'] = (
    options
  ) => {
    spawnedSessionIds.push(options.sessionId)
    return createMockSubprocess()
  }
  let server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess,
    // Hold siblings until one retriable reply makes the adapter disconnect their shared socket.
    preparePtySpawn: async () => {
      const preparationNumber = ++preparationCount
      if (preparationCount === concurrentSpawnCount) {
        allPreparationsEntered.resolve()
      }
      await allPreparationsEntered.promise
      if (preparationNumber === 1) {
        throw new Error('Connection lost')
      }
      await releaseHeldPreparations.promise
    }
  })
  await server.start()

  const respawn = vi.fn(async () => {
    await server.shutdown()
    releaseHeldPreparations.resolve()
    server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess })
    await server.start()
  })
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })

  try {
    const sessionIds = Array.from(
      { length: concurrentSpawnCount },
      (_, index) => `high-volume-${index}`
    )
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => adapter.spawn({ sessionId, cols: 80, rows: 24 }))
    )
    const recovered = results.filter((result) => result.status === 'fulfilled')
    const uncertain = results.filter((result) => result.status === 'rejected')

    expect(preparationCount).toBe(concurrentSpawnCount)
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith('daemon_died')
    expect(recovered).toHaveLength(1)
    expect(uncertain).toHaveLength(concurrentSpawnCount - 1)
    // Only the explicit prelaunch refusal permits replay; sibling disconnects lack receipts.
    for (const result of uncertain) {
      expect(result.reason).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
    }
    expect(spawnedSessionIds).toEqual(recovered.map(({ value }) => value.id))

    const later = await adapter.spawn({ sessionId: 'after-recovery', cols: 80, rows: 24 })
    expect(later.id).toBe('after-recovery')
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(spawnedSessionIds).toHaveLength(2)
  } finally {
    adapter.dispose()
    releaseHeldPreparations.resolve()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})
