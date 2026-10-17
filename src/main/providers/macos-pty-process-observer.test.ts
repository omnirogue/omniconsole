import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { armMacosPtyProcessObserver } from './macos-pty-process-observer'
import { assertNativeLaunchGateRequest } from './pty-launch-gate'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  path: vi.fn((): string | null => '/test/observer')
}))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: mocks.spawn }))
vi.mock('./macos-pty-process-observer-path', () => ({ resolveMacosPtyProcessObserver: mocks.path }))

const identity = {
  pid: 42,
  processStartTimeMs: 1700000000012,
  ptyRootPid: 41,
  ptyRootProcessStartTimeMs: 1700000000000
}
const physicalExit = {
  event: 'exited',
  pid: identity.pid,
  processStartTimeMs: identity.processStartTimeMs,
  exitCode: 37,
  signal: 0,
  waitStatus: 9472,
  observedAtMs: 1700000000900
}

function fixture() {
  const receipts = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stdio: [null, null, null, receipts]
  })
  const send = (message: unknown) => receipts.write(`${JSON.stringify(message)}\n`)
  mocks.spawn.mockReturnValue(child)
  const pending = armMacosPtyProcessObserver({
    rootPid: identity.ptyRootPid,
    shellPid: identity.pid,
    shellPath: '/bin/bash'
  })
  send({ event: 'armed', ...identity })
  return { child, send, pending }
}

afterEach(() => {
  mocks.path.mockReturnValue('/test/observer')
  vi.clearAllMocks()
})

describe('private native process observer receipts', () => {
  it('requires an armed observer and ignores ordinary stdout status claims', async () => {
    const { child, send, pending } = fixture()
    const observer = await pending
    expect(observer.identity).toEqual(identity)
    child.stdout.write(`${JSON.stringify(physicalExit)}\n`)
    const reading = observer.read()
    send({ event: 'checked', verified: true })
    expect(await reading).toEqual({ state: 'live', source: 'macos-kqueue' })
    send(physicalExit)
    child.emit('close', 0)
    expect(await observer.read()).toMatchObject({
      state: 'exited',
      exitCode: 37,
      signal: null,
      waitStatus: 9472
    })
    observer.dispose()
  })

  it('keeps the OS watch when a process-table miss races physical exit', async () => {
    const { send, pending } = fixture()
    const observer = await pending
    const reading = observer.read()
    send({ event: 'checked', verified: false })
    expect(await reading).toMatchObject({ state: 'unverifiable' })
    send(physicalExit)
    expect(await observer.read()).toMatchObject({ state: 'exited', exitCode: 37 })
    observer.dispose()
  })

  it('refuses release verification after identity loss without converting helper zero to exit proof', async () => {
    const { child, send, pending } = fixture()
    const observer = await pending
    const verifying = observer.verifyHeld()
    send({ event: 'checked', verified: false })
    await expect(verifying).rejects.toThrow('identity_unverifiable')
    child.emit('close', 0)
    expect(await observer.read()).toEqual({ state: 'unverifiable', reason: 'exit_observer_lost' })
  })

  it.each([
    { ...physicalExit, pid: 999 },
    { ...physicalExit, processStartTimeMs: 1 },
    { ...physicalExit, waitStatus: 0 }
  ])('rejects an exit for a different process identity', async (exit) => {
    const { send, pending } = fixture()
    const observer = await pending
    send(exit)
    expect(await observer.read()).toMatchObject({
      state: 'unverifiable',
      reason: 'exit_observer_protocol_invalid'
    })
  })

  it.skipIf(process.platform === 'win32')(
    'fails a required observation before any spawn when the helper is missing',
    () => {
      mocks.path.mockReturnValue(null)
      expect(() =>
        assertNativeLaunchGateRequest(
          {
            version: 1,
            launchId: 'test',
            startupCommandMode: 'exec',
            processObservation: 'required'
          },
          'claude'
        )
      ).toThrow('exit_observer_unavailable')
      expect(mocks.spawn).not.toHaveBeenCalled()
    }
  )
})
