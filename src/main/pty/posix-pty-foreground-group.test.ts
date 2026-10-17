import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  getPosixPtyForegroundGroup,
  parsePosixReceiverRow,
  parsePsLstartUtc,
  readPosixReceiverRow,
  readPosixReceiverRowSync,
  readPosixSpawnRootRowSync,
  signalPosixPtyForegroundGroup
} from './posix-pty-foreground-group'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }))
const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess }))

// The concatenated output of two `ps -p <pid> -o pid=,tpgid=,tty=` calls.
const macosTable = ['84644 84985 ttys318', '  4242     4242 ttys002'].join('\n')

describe('getPosixPtyForegroundGroup', () => {
  it('returns the tty foreground group, not the root pid group', () => {
    // Why: on macOS the root is login(1) and the shell setpgid's into its own group,
    // so the root pid is never a member of the group a real resize signals.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys318', 4242)).toBe(84985)
  })

  it('accepts a Linux pts device name', () => {
    expect(getPosixPtyForegroundGroup('900 931 pts/3', 900, '/dev/pts/3', 4242)).toBe(931)
  })

  it('refuses when the pid now answers for a different tty', () => {
    // Why: `ps -p` answers for whoever owns the pid now — a recycled pid must not
    // aim a group signal at a real terminal.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys999', 4242)).toBeNull()
  })

  it('refuses when this process shares the PTY', () => {
    // Why: a dev daemon can inherit its launch TTY; group-signalling would hit Orca.
    const shared = ['84644 84985 ttys318', '4242 84985 ttys318'].join('\n')
    expect(getPosixPtyForegroundGroup(shared, 84644, '/dev/ttys318', 4242)).toBeNull()
  })

  it('refuses a detached tty or an unowned foreground group', () => {
    expect(getPosixPtyForegroundGroup('84644 84985 ??', 84644, '/dev/ttys318', 4242)).toBeNull()
    expect(getPosixPtyForegroundGroup('84644 -1 ttys318', 84644, '/dev/ttys318', 4242)).toBeNull()
    expect(getPosixPtyForegroundGroup('84644 1 ttys318', 84644, '/dev/ttys318', 4242)).toBeNull()
  })

  it('refuses when the root pid is absent from the table', () => {
    expect(getPosixPtyForegroundGroup('4242 4242 ttys002', 84644, '/dev/ttys318', 4242)).toBeNull()
  })
})

describe('signalPosixPtyForegroundGroup', () => {
  const table = (): string => macosTable

  it('signals the negated foreground group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(kill).toHaveBeenCalledWith(-84985, 'SIGWINCH')
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back to the root pid on Windows', () => {
    // Why: a negative pid is invalid there, and SIGTERM/SIGINT mean terminate.
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'win32',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the slave device name is unknown', () => {
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, undefined, 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the process table cannot be read', () => {
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: () => {
        throw new Error('ps timed out')
      }
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('treats a vanished foreground group as done rather than falling back', () => {
    // Why: the fallback target is just as stale, and re-signalling a recycled pid is worse.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back when foreground group signalling fails', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(fallback).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })
})

describe('process table lookup', () => {
  it('asks ps for one pid at a time', () => {
    // Why pinned: macOS ps only takes its by-pid fast path for a SINGLE pid. Any list
    // form walks the whole process table (~3.6s on a busy machine vs ~3ms), which
    // exceeds this module's timeout and silently reinstates root-pid delivery — the
    // exact bug it exists to fix. Regressing this looks like a working feature.
    const execFileSyncMock = vi.mocked(execFileSync)
    execFileSyncMock.mockClear()
    execFileSyncMock.mockReturnValue('84644 84985 ttys318' as never)
    // Why stubbed: the resolver succeeds against the mocked table, so a live
    // process.kill would aim a real group signal at whatever owns pgid 84985 here.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', vi.fn(), {
        platform: 'darwin',
        currentPid: 4242
      })

      expect(execFileSyncMock).toHaveBeenCalled()
      let timeoutBudget = 0
      for (const call of execFileSyncMock.mock.calls) {
        const args = call[1] as string[]
        const options = call[2] as { timeout: number }
        const pidArg = args[args.indexOf('-p') + 1]
        expect(pidArg).toMatch(/^\d+$/)
        expect(args.filter((arg) => arg === '-p')).toHaveLength(1)
        timeoutBudget += options.timeout
      }
      expect(timeoutBudget).toBeLessThanOrEqual(250)
    } finally {
      kill.mockRestore()
    }
  })
})

describe('the receiver row a guarded write checks', () => {
  const STARTED = 'Thu Sep 24 10:11:12 2026'

  it('reads its group, its tty’s foreground group, its tty and its start time', () => {
    expect(parsePosixReceiverRow(`4242  4242  4242 ttys007  ${STARTED}\n`, 4242)).toEqual({
      pgid: 4242,
      tpgid: 4242,
      tty: 'ttys007',
      startTimeMs: Date.UTC(2026, 8, 24, 10, 11, 12)
    })
    expect(parsePosixReceiverRow('4242 4242 4242 ttys007 not a date', 4242)).toMatchObject({
      startTimeMs: null
    })
  })

  it('retains live process status and full command beside the same start time', () => {
    expect(
      parsePosixReceiverRow(
        `4242 4242 4242 ttys007 ${STARTED} S+ /opt/bin/claude --resume session`,
        4242
      )
    ).toMatchObject({
      stat: 'S+',
      command: '/opt/bin/claude --resume session',
      startTimeMs: Date.UTC(2026, 8, 24, 10, 11, 12)
    })
  })

  it('refuses another pid’s row, a process with no tty, and no row', () => {
    expect(parsePosixReceiverRow(`4243 4243 4243 ttys007 ${STARTED}`, 4242)).toBeNull()
    expect(parsePosixReceiverRow(`4242 4242 -1 ?? ${STARTED}`, 4242)).toBeNull()
    expect(parsePosixReceiverRow('', 4242)).toBeNull()
  })

  it('pins spawn birth before TTY acquisition without weakening receiver reads', () => {
    const row = `4242 4242 0 ?? ${STARTED} Ss /bin/zsh`
    vi.mocked(execFileSync).mockReturnValueOnce(row)
    expect(readPosixSpawnRootRowSync(4242)).toEqual({
      tty: '??',
      startTimeMs: Date.UTC(2026, 8, 24, 10, 11, 12)
    })
    vi.mocked(execFileSync).mockReturnValueOnce(row)
    expect(readPosixReceiverRowSync(4242)).toBeNull()
    expect(parsePosixReceiverRow(row, 4242)).toBeNull()
  })

  it('reads lstart as UTC, whatever the reading process’s own zone, and nothing else', () => {
    expect(parsePsLstartUtc('Thu Sep 24 16:11:12 2026')).toBe(Date.UTC(2026, 8, 24, 16, 11, 12))
    expect(parsePsLstartUtc('Mon Jan  5 03:04:05 2026')).toBe(Date.UTC(2026, 0, 5, 3, 4, 5))
    expect(parsePsLstartUtc('24 Sep 2026 16:11:12')).toBeNull()
    expect(parsePsLstartUtc('Thu Foo 24 16:11:12 2026')).toBeNull()
  })

  it('asks ps for that one pid, in the C locale and UTC', () => {
    vi.mocked(execFileSync).mockReturnValueOnce(`4242 4242 4242 pts/3 ${STARTED}`)
    expect(readPosixReceiverRowSync(4242)).toMatchObject({ tty: 'pts/3', pgid: 4242 })
    expect(execFileSync).toHaveBeenLastCalledWith(
      'ps',
      ['-p', '4242', '-o', 'pid=,pgid=,tpgid=,tty=,lstart=,stat=,command='],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }) })
    )
  })

  it('reads the same row without blocking, and nothing from a failed or cut-off ps', async () => {
    const result = { code: 0, signal: null, stderr: '', timedOut: false }
    runProcess.mockResolvedValueOnce({ ...result, stdout: `4242 4242 4242 pts/3 ${STARTED}` })
    expect(await readPosixReceiverRow(4242)).toMatchObject({ tty: 'pts/3', pgid: 4242 })
    expect(runProcess).toHaveBeenLastCalledWith(
      expect.objectContaining({
        program: 'ps',
        args: ['-p', '4242', '-o', 'pid=,pgid=,tpgid=,tty=,lstart=,stat=,command='],
        env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' })
      })
    )
    runProcess.mockResolvedValueOnce({ ...result, code: 1, stdout: '' })
    expect(await readPosixReceiverRow(4242)).toBeNull()
    runProcess.mockResolvedValueOnce({
      ...result,
      timedOut: true,
      stdout: `4242 4242 4242 pts/3 ${STARTED}`
    })
    expect(await readPosixReceiverRow(4242)).toBeNull()
    runProcess.mockResolvedValueOnce({ ...result, stdout: `4242 4242 -1 ?? ${STARTED}` })
    expect(await readPosixReceiverRow(4242)).toBeNull()
    runProcess.mockRejectedValueOnce(new Error('spawn ps ENOENT'))
    expect(await readPosixReceiverRow(4242)).toBeNull()
  })
})
