import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readPosixReceiverRowSync } from '../main/pty/posix-pty-foreground-group'
import { RelayAgentInterrupts } from './pty-agent-interrupt'
import type { TerminalAgentProcessProof } from '../shared/pty-agent-process-evidence'

vi.mock('../main/pty/posix-pty-foreground-group', () => ({
  readPosixReceiverRowSync: vi.fn(),
  PS_LSTART_TOLERANCE_MS: 1000
}))

function fixture() {
  let now = 0
  const guard = new RelayAgentInterrupts(() => now)
  const root = { pid: 100, startTimeMs: 10000, tty: 'pts/3' }
  const owner = {
    id: 'pty-a',
    incarnationId: 'birth-a',
    disposed: false,
    pty: { pid: 100, process: 'claude', ptsName: '/dev/pts/3' },
    agentProcessRoot: root,
    inputGeneration: 0
  }
  const proof: TerminalAgentProcessProof = {
    ptyId: owner.id,
    incarnationId: owner.incarnationId,
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: 20000,
    agent: 'claude',
    via: 'command-line'
  }
  const rootRow = {
    pgid: 100,
    tpgid: 200,
    tty: 'pts/3',
    startTimeMs: 10000,
    stat: 'Ss',
    command: '/bin/zsh'
  }
  const row = { ...rootRow, pgid: 200, startTimeMs: 20000, stat: 'S+', command: '/bin/claude' }
  vi.mocked(readPosixReceiverRowSync).mockImplementation((pid) => (pid === 100 ? rootRow : row))
  const getOwner = vi.fn(() => owner)
  const current = vi.fn(() => true)
  const write = vi.fn(() => {
    owner.inputGeneration++
  })
  const request = {
    id: owner.id,
    incarnationId: owner.incarnationId,
    interruptToken: guard.issue(owner, proof)!
  }
  const interrupt = () => guard.interrupt(request, getOwner, current, write)
  return {
    guard,
    owner,
    proof,
    rootRow,
    row,
    getOwner,
    current,
    write,
    request,
    interrupt,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe.skipIf(process.platform === 'win32')('owner-guarded SSH interrupt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes once and replays the exact acknowledgement without sending another Ctrl+C', () => {
    const f = fixture()
    expect(f.interrupt()).toMatchObject({ ...f.request, outcome: 'written' })
    expect(f.interrupt()).toMatchObject({ outcome: 'written' })
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it.each([
    'input',
    'root birth',
    'receiver birth',
    'shell',
    'foreground',
    'stopped',
    'disposed',
    'connection',
    'expiry'
  ])('does not write after %s changes', (change) => {
    const f = fixture()
    if (change === 'input') {
      f.owner.inputGeneration++
    }
    if (change === 'root birth') {
      f.rootRow.startTimeMs++
    }
    if (change === 'receiver birth') {
      f.row.startTimeMs++
    }
    if (change === 'shell') {
      f.row.command = '/bin/zsh'
    }
    if (change === 'foreground') {
      f.row.tpgid = 300
    }
    if (change === 'stopped') {
      f.row.stat = 'T+'
    }
    if (change === 'disposed') {
      f.owner.disposed = true
    }
    if (change === 'connection') {
      f.current.mockReturnValue(false)
    }
    if (change === 'expiry') {
      f.advance(15001)
    }
    expect(['refused', 'revoked']).toContain(f.interrupt().outcome)
    expect(f.write).not.toHaveBeenCalled()
  })

  it('rechecks input and connection immediately before the synchronous write', () => {
    const f = fixture()
    vi.mocked(readPosixReceiverRowSync).mockImplementation((pid) => {
      if (pid === 200) {
        f.owner.inputGeneration++
      }
      return pid === 100 ? f.rootRow : f.row
    })
    expect(f.interrupt().outcome).toBe('revoked')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('never says nothing happened for an absent, replaced or evicted receipt', () => {
    const f = fixture()
    expect(f.interrupt().outcome).toBe('written')
    f.getOwner.mockReturnValue({ ...f.owner })
    expect(f.interrupt().outcome).toBe('unknown')
    f.getOwner.mockReturnValue(f.owner)
    for (let i = 0; i < 32; i++) {
      f.guard.issue(f.owner, f.proof)
    }
    expect(f.interrupt().outcome).toBe('unknown')
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('keeps a throwing write uncertain and never repeats it', () => {
    const f = fixture()
    f.write.mockImplementation(() => {
      throw new Error('may have written')
    })
    expect(f.interrupt().outcome).toBe('unknown')
    expect(f.interrupt().outcome).toBe('unknown')
    expect(f.write).toHaveBeenCalledTimes(1)
  })
})
