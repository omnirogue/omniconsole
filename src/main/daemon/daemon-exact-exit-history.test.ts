import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { DaemonServer } from './daemon-server'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalHost } from './terminal-host'
import { readTerminalHistoryExactExit } from './terminal-history-exact-exit'

function createSubprocess(): SubprocessHandle & {
  exit(code: number, cause?: TerminalExitCause): void
  data(chunk: string): void
} {
  let onExit: (code: number, cause?: TerminalExitCause) => void = () => {}
  let onData: (data: string) => void = () => {}
  return {
    pid: 43210,
    write: vi.fn(),
    resize: vi.fn(),
    signal: vi.fn(),
    kill: () => onExit(0, { kind: 'operator_close' }),
    forceKill: () => onExit(0, { kind: 'signaled', signal: 9 }),
    terminateOwnedTree: () => 'unavailable',
    getForegroundProcess: () => null,
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    exit: (code, cause) => onExit(code, cause),
    data: (chunk) => onData(chunk)
  }
}

describe.skipIf(process.platform === 'win32')('daemon-owned exact exit history', () => {
  let directory: string
  let historyPath: string
  let server: DaemonServer | undefined
  let directSession: Session | undefined
  let subprocess: ReturnType<typeof createSubprocess>

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-exact-exit-'))
    historyPath = join(directory, 'terminal-history')
    subprocess = createSubprocess()
  })

  afterEach(async () => {
    directSession?.dispose()
    directSession = undefined
    await server?.shutdown()
    server = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  function createOwner(): TerminalHost {
    server = new DaemonServer({
      socketPath: join(directory, 'daemon.sock'),
      tokenPath: join(directory, 'daemon.token'),
      terminalHistoryPath: historyPath,
      spawnSubprocess: () => subprocess
    })
    return (server as unknown as { host: TerminalHost }).host
  }

  it('persists before broadcast and reaping without a HistoryManager', async () => {
    const host = createOwner()
    const onExit = vi.fn((_code: number, incarnationId: string) => {
      expect(readTerminalHistoryExactExit(historyPath, 'worker', incarnationId)).toMatchObject({
        status: 'readable',
        observation: {
          pid: 43210,
          exitCode: 0,
          exitCause: { kind: 'exited', exitCode: 0 },
          terminalStream: {
            version: 1,
            lines: ['complete', 'final partial'],
            partialLine: '',
            completedLineCount: 2,
            truncated: false
          }
        }
      })
    })
    const result = await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit }
    })

    subprocess.data('complete\r\nfinal partial')
    subprocess.exit(0, { kind: 'exited', exitCode: 0 })

    expect(onExit).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
    expect(readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)).toMatchObject(
      {
        status: 'readable',
        observation: { sessionId: 'worker', incarnationId: result.incarnationId }
      }
    )
  })

  it('retains an exit while every runtime listener is disconnected', async () => {
    const host = createOwner()
    const onExit = vi.fn()
    const result = await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit }
    })
    subprocess.data('before disconnect\n')
    host.detach('worker', result.attachToken)
    subprocess.data('offline final')

    subprocess.exit(7, { kind: 'exited', exitCode: 7 })
    await server!.shutdown()
    server = undefined

    expect(onExit).not.toHaveBeenCalled()
    expect(readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)).toMatchObject(
      {
        status: 'readable',
        observation: {
          exitCode: 7,
          terminalStream: {
            lines: ['before disconnect', 'offline final'],
            partialLine: '',
            completedLineCount: 2
          }
        }
      }
    )
    expect(readTerminalHistoryExactExit(historyPath, 'worker', 'replacement-incarnation')).toEqual({
      status: 'missing'
    })
  })

  it('records an exit that arrives before session publication or history initialization', async () => {
    subprocess.onData = (callback) => callback('early final')
    subprocess.onExit = (callback) => callback(0, { kind: 'exited', exitCode: 0 })
    const host = createOwner()
    const result = await host.createOrAttach({
      sessionId: 'early-worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(
      readTerminalHistoryExactExit(historyPath, 'early-worker', result.incarnationId)
    ).toMatchObject({
      status: 'readable',
      observation: {
        exitCode: 0,
        pid: subprocess.pid,
        terminalStream: { lines: ['early final'], partialLine: '', completedLineCount: 1 }
      }
    })
  })

  it('drains recovery-held output before committing the immutable exit snapshot', async () => {
    const host = createOwner()
    const chunks: string[] = []
    const result = await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: {
        onData: (data) => chunks.push(data),
        onExit: (_code, incarnationId) => {
          expect(chunks.join('')).toContain('after barrier\nfinal tail')
          expect(readTerminalHistoryExactExit(historyPath, 'worker', incarnationId)).toMatchObject({
            status: 'readable',
            observation: {
              terminalStream: {
                lines: expect.arrayContaining(['after barrier', 'final tail']),
                partialLine: ''
              }
            }
          })
        }
      }
    })
    subprocess.data('before\n\x1b[?1049hTUI\n\x1b]133;D;7\x07')
    subprocess.data('after barrier\nfinal tail')
    expect(chunks.join('')).not.toContain('after barrier')

    subprocess.exit(7, { kind: 'exited', exitCode: 7 })
    const first = readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)
    subprocess.exit(7, { kind: 'exited', exitCode: 7 })
    expect(readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)).toEqual(first)
  })

  it('keeps the latest transcript after the independent pending-output buffer overflows', async () => {
    const host = createOwner()
    const result = await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    subprocess.data(`${'x'.repeat(1023)}\n`.repeat(2050))
    subprocess.data('retained after overflow')
    subprocess.exit(7, { kind: 'exited', exitCode: 7 })

    const receipt = readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)
    expect(receipt.status).toBe('readable')
    if (receipt.status !== 'readable') {
      throw new Error('Missing exit receipt')
    }
    expect(receipt.observation.terminalStream?.lines.at(-1)).toBe('retained after overflow')
    expect(receipt.observation.terminalStream).toMatchObject({
      truncated: true,
      partialLine: '',
      completedLineCount: 2051
    })
  })

  it('records only this process output after startup query and echo filtering', () => {
    const onPhysicalExit = vi.fn()
    directSession = new Session({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      subprocess,
      onPhysicalExit,
      historySeedChunks: ['previous process output\n'],
      ownerBackend: 'windows-conpty',
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })
    subprocess.data('\x1b]10;?\x07')
    subprocess.data(']10;rgb:2e2e/3434/3434\\')
    subprocess.data('current output')
    subprocess.exit(0, { kind: 'exited', exitCode: 0 })
    expect(onPhysicalExit).toHaveBeenCalledOnce()
    expect(onPhysicalExit.mock.calls[0][0].terminalStream).toMatchObject({
      lines: ['current output'],
      partialLine: '',
      completedLineCount: 1
    })
  })

  it.each([
    [0, undefined, { kind: 'unknown', reason: 'cause_unreported' }],
    [0, { kind: 'signaled', signal: 15 }, { kind: 'signaled', signal: 15 }],
    [0, { kind: 'operator_close' }, { kind: 'operator_close' }]
  ] as const)(
    'does not invent success from physical code %i with cause %j',
    async (code, cause, expected) => {
      const host = createOwner()
      const result = await host.createOrAttach({
        sessionId: 'worker',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      subprocess.exit(code, cause)
      expect(
        readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)
      ).toMatchObject({
        status: 'readable',
        observation: { exitCode: null, exitCause: expected }
      })
    }
  )

  it('leaves unverified negative status without durable death evidence', async () => {
    const host = createOwner()
    const result = await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    subprocess.exit(-1)
    expect(readTerminalHistoryExactExit(historyPath, 'worker', result.incarnationId)).toEqual({
      status: 'missing'
    })
  })

  it('continues broadcast and reaping when durable history cannot be written', async () => {
    writeFileSync(historyPath, 'unavailable')
    const host = createOwner()
    const onExit = vi.fn()
    await host.createOrAttach({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit }
    })
    expect(() => subprocess.exit(0, { kind: 'exited', exitCode: 0 })).not.toThrow()
    expect(onExit).toHaveBeenCalledOnce()
    expect(host.listSessions()).toEqual([])
  })

  it('does not treat disposal as a physical exit', () => {
    const onPhysicalExit = vi.fn()
    directSession = new Session({
      sessionId: 'worker',
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      subprocess,
      onPhysicalExit
    })
    directSession.dispose()
    expect(onPhysicalExit).not.toHaveBeenCalled()
  })
})
