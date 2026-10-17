import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureTransferExecution } from './session-transfer-execution'
import { transferSession } from './session-manage-transfer-fixtures'
import type { PosixReceiverRow } from '../pty/posix-pty-foreground-group'

const mocks = vi.hoisted(() => ({ read: vi.fn(), host: null as unknown }))
vi.mock('../pty/posix-pty-foreground-group', () => ({
  readPosixReceiverRowSync: mocks.read,
  PS_LSTART_TOLERANCE_MS: 1000
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.host
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.host = null
})

function fixture() {
  const source = transferSession('source')
  source.entry.terminal = 'terminal'
  source.agentProcess = {
    ptyId: 'pty',
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: 1000,
    incarnationId: 'birth',
    agent: 'claude',
    via: 'command-line'
  }
  let row: PosixReceiverRow | null = {
    pgid: 200,
    tpgid: 200,
    startTimeMs: 1000,
    tty: 'ttys001',
    stat: 'S+',
    command: '/opt/bin/claude'
  }
  mocks.read.mockImplementation((pid: number) =>
    pid === 100
      ? { pgid: 100, tpgid: 200, startTimeMs: 500, tty: 'ttys001', stat: 'S', command: '/bin/zsh' }
      : row
  )
  const runtime = {
    resolveTerminalPane: vi.fn(() => ({ handle: 'terminal', ptyId: 'pty', connected: true })),
    getTerminalProcessIncarnation: vi.fn(() => 'pty:birth')
  }
  const current = captureTransferExecution(runtime as never, source)
  return {
    current,
    runtime,
    set: (next: PosixReceiverRow | null) => {
      row = next
    },
    row: row!
  }
}

describe('archive execution identity', () => {
  it('requires the captured live receiver at the final archive commit', () => {
    expect(fixture().current()).toBe(true)
  })

  it.each(['exit', 'exec', 'stopped', 'pid reused', 'background'])(
    'refuses %s without needing another hook',
    (change) => {
      const f = fixture()
      f.set(
        change === 'exit'
          ? null
          : {
              ...f.row,
              ...(change === 'exec' ? { command: '/bin/zsh' } : {}),
              ...(change === 'stopped' ? { stat: 'T+' } : {}),
              ...(change === 'pid reused' ? { startTimeMs: 9000 } : {}),
              ...(change === 'background' ? { tpgid: 300 } : {})
            }
      )
      expect(f.current()).toBe(false)
    }
  )

  it('refuses a PTY rebind even when the old PID remains live', () => {
    const f = fixture()
    f.runtime.resolveTerminalPane.mockReturnValue({
      handle: 'terminal',
      ptyId: 'replacement',
      connected: true
    })
    expect(f.current()).toBe(false)
  })

  it('retains exact structured ownership and revokes on lease or host change', () => {
    const source = transferSession('chat')
    source.source = {
      kind: 'structured',
      paneKey: 'chat',
      worktreeId: source.entry.worktreeId,
      sessionId: 'session'
    }
    const transferOwnership = vi.fn(() => 'session:fence:receipt')
    mocks.host = { outcomeSource: { transferOwnership } }
    const current = captureTransferExecution({} as never, source)
    expect(current()).toBe(true)
    transferOwnership.mockReturnValue('session:new-fence:receipt')
    expect(current()).toBe(false)
    mocks.host = null
    expect(current()).toBe(false)
  })
})
