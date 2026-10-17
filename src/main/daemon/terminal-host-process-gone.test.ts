/**
 * #843: a session whose child is already gone but whose exit callback never fired
 * stayed `isAlive` forever. Every kill on it failed (SIGKILL → ESRCH), the failure
 * was sticky, and main turned each listing into an empty placeholder terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

const GONE_PID = 424_242

function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

function createSubprocess(pid: number): SubprocessHandle & {
  exit: (code: number) => void
} {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      throw esrch()
    }),
    signal: vi.fn(),
    onData: () => {},
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    exit(code: number) {
      onExitCb?.(code)
    }
  }
}

describe('TerminalHost process-gone sessions (#843)', () => {
  let host: TerminalHost
  let subprocess: ReturnType<typeof createSubprocess>
  let goneAfterForceKill: boolean
  let platformDescriptor: PropertyDescriptor | undefined
  const onSessionReaped = vi.fn()
  const onSessionProcessGone = vi.fn()
  const isProcessGone = vi.fn((pid: number) => {
    if (pid !== GONE_PID) {
      return false
    }
    return !goneAfterForceKill || vi.mocked(subprocess.forceKill).mock.calls.length > 0
  })

  beforeEach(() => {
    // Pin POSIX so immediate teardown takes the plain force-kill path on every host OS.
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    goneAfterForceKill = false
    onSessionReaped.mockReset()
    onSessionProcessGone.mockReset()
    isProcessGone.mockClear()
    host = new TerminalHost({
      spawnSubprocess: () => subprocess,
      onSessionReaped,
      isProcessGone,
      onSessionProcessGone,
      processGoneExitGraceMs: 0
    })
  })

  afterEach(async () => {
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  async function createSession(sessionId: string, pid: number) {
    subprocess = createSubprocess(pid)
    const streamClient = { onData: vi.fn(), onExit: vi.fn() }
    await host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient })
    return streamClient
  }

  it('reaps a session whose process is already gone instead of failing the kill', async () => {
    const client = await createSession('wt@@stale', GONE_PID)

    await expect(host.kill('wt@@stale', { immediate: true })).resolves.toBeUndefined()

    // Never signal a pid the OS already reports gone: POSIX may have recycled it.
    expect(subprocess.kill).not.toHaveBeenCalled()
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(onSessionReaped).toHaveBeenCalledWith('wt@@stale')
    expect(onSessionProcessGone).toHaveBeenCalledWith('wt@@stale', GONE_PID)
    expect(client.onExit).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
    expect(host.isKilled('wt@@stale')).toBe(true)
    // Not sticky: a later kill sees an absent session, not a live one it cannot kill.
    expect(() => host.kill('wt@@stale')).toThrow('Session not found')
  })

  it('reaps the session when the force-kill fails because the process is gone', async () => {
    goneAfterForceKill = true
    await createSession('wt@@raced', GONE_PID)

    await expect(host.kill('wt@@raced', { immediate: true })).resolves.toBeUndefined()

    expect(subprocess.forceKill).toHaveBeenCalled()
    expect(onSessionProcessGone).toHaveBeenCalledWith('wt@@raced', GONE_PID)
    expect(onSessionReaped).toHaveBeenCalledWith('wt@@raced')
    expect(host.listSessions()).toEqual([])
  })

  it('still rethrows a kill failure on a live process and keeps the session', async () => {
    await createSession('wt@@live', 31_337)
    vi.mocked(subprocess.forceKill).mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })

    await expect(host.kill('wt@@live', { immediate: true })).rejects.toThrow('kill EPERM')

    expect(onSessionProcessGone).not.toHaveBeenCalled()
    expect(onSessionReaped).not.toHaveBeenCalled()
    expect(host.listSessions().map((session) => session.sessionId)).toEqual(['wt@@live'])
    // Let afterEach's host.dispose() tear the live child down.
    vi.mocked(subprocess.forceKill).mockImplementation(() => subprocess.exit(137))
  })

  it('never lists a session whose process is gone, and reaps it through the exit path', async () => {
    await createSession('wt@@inherited', GONE_PID)

    expect(host.listSessions()).toEqual([])

    await vi.waitFor(() => expect(onSessionReaped).toHaveBeenCalledWith('wt@@inherited'))
    expect(onSessionProcessGone).toHaveBeenCalledWith('wt@@inherited', GONE_PID)
    isProcessGone.mockReturnValue(false)
    expect(host.listSessions()).toEqual([])
  })

  it('lets a natural exit inside the grace window win over the synthesized one', async () => {
    await host.dispose()
    host = new TerminalHost({
      spawnSubprocess: () => subprocess,
      onSessionReaped,
      isProcessGone,
      onSessionProcessGone,
      processGoneExitGraceMs: 50
    })
    await createSession('wt@@exiting', GONE_PID)

    const killed = host.kill('wt@@exiting')
    subprocess.exit(0)
    await killed

    expect(onSessionReaped).toHaveBeenCalledWith('wt@@exiting')
    expect(onSessionProcessGone).not.toHaveBeenCalled()
  })
})
