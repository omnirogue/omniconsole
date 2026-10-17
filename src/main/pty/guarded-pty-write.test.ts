import { describe, expect, it, vi } from 'vitest'
import { guardedPtyWrite, isGuardedWriteReceiver } from './guarded-pty-write'
import type { PosixReceiverRow } from './posix-pty-foreground-group'

const RECEIVER = { pid: 4242, pgid: 4242, startTimeMs: 1_000_000 }
// The bound agent leads the tty's foreground group, on the PTY it was bound on.
const HOLDS: PosixReceiverRow = { pgid: 4242, tpgid: 4242, tty: 'ttys007', startTimeMs: 1_000_500 }

function attempt(over: {
  row?: PosixReceiverRow | null
  leaders?: (string | undefined)[]
  ptsName?: string | undefined
  platform?: NodeJS.Platform
  fenceRevoked?: () => boolean
}) {
  const write = vi.fn()
  const readReceiver = vi.fn(() => (over.row === undefined ? HOLDS : over.row))
  const leaders = [...(over.leaders ?? ['claude', 'claude'])]
  const outcome = guardedPtyWrite({
    ptsName: 'ptsName' in over ? over.ptsName : '/dev/ttys007',
    receiver: RECEIVER,
    readLeaderName: () => leaders.shift(),
    write,
    platform: over.platform ?? 'darwin',
    readReceiver,
    ...(over.fenceRevoked ? { fenceRevoked: over.fenceRevoked } : {})
  })
  return { outcome, write, readReceiver }
}

describe('guardedPtyWrite', () => {
  it('writes while the bound process leads the tty’s foreground group', () => {
    const { outcome, write, readReceiver } = attempt({})
    expect(outcome).toBe('written')
    expect(write).toHaveBeenCalledOnce()
    expect(readReceiver).toHaveBeenCalledWith(4242)
  })

  it('refuses once another group holds the tty: the shell after Ctrl-Z, or a new program', () => {
    // The agent is still alive in its own group, but the shell's group (100) holds the tty.
    expect(attempt({ row: { ...HOLDS, tpgid: 100 } }).outcome).toBe('refused')
    expect(attempt({ row: { ...HOLDS, pgid: 5000, tpgid: 5000 } }).outcome).toBe('refused')
    expect(attempt({ row: { ...HOLDS, tpgid: 100 } }).write).not.toHaveBeenCalled()
  })

  it('refuses a reused pid, another tty, or a process it cannot read', () => {
    expect(attempt({ row: { ...HOLDS, startTimeMs: 1_060_000 } }).outcome).toBe('refused')
    expect(attempt({ row: { ...HOLDS, startTimeMs: null } }).outcome).toBe('refused')
    expect(attempt({ row: { ...HOLDS, tty: 'ttys008' } }).outcome).toBe('refused')
    expect(attempt({ row: null }).outcome).toBe('refused')
  })

  it('refuses when the foreground leader changes around the read, or is a shell', () => {
    expect(attempt({ leaders: ['claude', 'zsh'] }).outcome).toBe('refused')
    expect(attempt({ leaders: ['zsh', 'zsh'] }).outcome).toBe('refused')
    expect(attempt({ leaders: [undefined, undefined] }).outcome).toBe('refused')
  })

  it('refuses a write whose conversation fence was revoked', () => {
    const revoked = attempt({ fenceRevoked: () => true })
    expect(revoked.outcome).toBe('revoked')
    expect(revoked.write).not.toHaveBeenCalled()
    // A check that cannot answer refuses too.
    const broken = attempt({
      fenceRevoked: () => {
        throw new Error('gone')
      }
    })
    expect(broken.outcome).toBe('revoked')
    expect(attempt({ fenceRevoked: () => false }).outcome).toBe('written')
  })

  it('checks foreground again after the slow owner-liveness probe', () => {
    let leader = 'claude'
    const write = vi.fn()
    expect(
      guardedPtyWrite({
        ptsName: '/dev/ttys007',
        receiver: RECEIVER,
        platform: 'darwin',
        readReceiver: () => HOLDS,
        readLeaderName: () => leader,
        fenceRevoked: () => {
          leader = 'zsh'
          return false
        },
        write
      })
    ).toBe('refused')
    expect(write).not.toHaveBeenCalled()
  })

  it('cannot check on Windows or without the slave tty’s name, so it never writes there', () => {
    for (const over of [{ platform: 'win32' as const }, { ptsName: undefined }]) {
      const { outcome, write, readReceiver } = attempt(over)
      expect(outcome).toBe('unsupported')
      expect(write).not.toHaveBeenCalled()
      expect(readReceiver).not.toHaveBeenCalled()
    }
  })
})

describe('isGuardedWriteReceiver', () => {
  it('takes only a whole receiver: a pid, its group and its start time', () => {
    expect(isGuardedWriteReceiver(RECEIVER)).toBe(true)
    expect(isGuardedWriteReceiver({ pid: 4242, pgid: 4242 })).toBe(false)
    expect(isGuardedWriteReceiver({ ...RECEIVER, pgid: 1 })).toBe(false)
    expect(isGuardedWriteReceiver({ ...RECEIVER, startTimeMs: null })).toBe(false)
    expect(isGuardedWriteReceiver(null)).toBe(false)
  })
})
