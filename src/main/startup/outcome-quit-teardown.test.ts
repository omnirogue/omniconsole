import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { settleTeardownWithinDeadline } from '../quit-teardown-deadline'
import { beginOutcomeQuitTeardowns } from './outcome-quit-teardown'

it('persists SSH detachment and completes legacy cleanup while an outcome launch never settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outcome-quit-'))
  try {
    const state = { sshLease: 'attached', nativePty: 'running' }
    const cleanup: string[] = []
    let finishSsh!: () => void
    const teardowns = beginOutcomeQuitTeardowns({
      suspension: new Promise(() => {}),
      beginSshShutdown: () => {
        state.sshLease = 'detached'
        return new Promise<void>((resolve) => {
          finishSsh = resolve
        })
      },
      flushState: () => writeFile(join(directory, 'profile.json'), JSON.stringify(state)),
      killNativePty: () => {
        state.nativePty = 'stopped'
        cleanup.push('pty')
      },
      disconnectDaemon: async () => {
        cleanup.push('daemon')
      }
    })
    await teardowns.find((entry) => entry.name === 'state')!.promise
    expect(JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))).toEqual({
      sshLease: 'detached',
      nativePty: 'stopped'
    })
    expect(cleanup).toEqual(['pty', 'daemon'])
    finishSsh()
    vi.useFakeTimers()
    const settled = settleTeardownWithinDeadline(teardowns, 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(settled).resolves.toEqual(['outcome-continuation'])
  } finally {
    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  }
})

it('joins a rejected outcome drain without dropping the existing cleanup receipts', async () => {
  const teardowns = beginOutcomeQuitTeardowns({
    suspension: Promise.reject(new Error('worker disconnected')),
    beginSshShutdown: async () => {},
    flushState: async () => {},
    killNativePty: async () => {},
    disconnectDaemon: async () => {}
  })
  await expect(settleTeardownWithinDeadline(teardowns)).resolves.toEqual([])
})
