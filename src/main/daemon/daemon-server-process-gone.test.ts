import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import type { DaemonRequest } from './types'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import type { TerminalHost } from './terminal-host'

type DaemonServerPrivate = {
  host: TerminalHost
  requestRouter: {
    route(clientId: string, request: DaemonRequest): Promise<unknown>
  }
}

const GONE_PID = 424_243

describe('daemon kill of a session whose process is gone (#843)', () => {
  let server: DaemonServer
  let dir: string

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('logs session-exited with cause process-gone instead of a sticky session-kill-failed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-process-gone-'))
    const daemonLog = { log: vi.fn(), close: vi.fn() }
    const subprocess = { ...createMockSubprocess(), pid: GONE_PID }
    subprocess.forceKill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    server = new DaemonServer({
      socketPath: join(dir, 'daemon.sock'),
      tokenPath: join(dir, 'daemon.token'),
      log: daemonLog,
      isPtyProcessGone: (pid) => pid === GONE_PID,
      spawnSubprocess: () => subprocess
    })
    const daemon = server as unknown as DaemonServerPrivate
    await daemon.host.createOrAttach({
      sessionId: 'wt@@stale',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    await expect(
      daemon.requestRouter.route('control-1', { id: 'list-1', type: 'listSessions' })
    ).resolves.toEqual({ sessions: [] })
    await daemon.requestRouter.route('control-1', {
      id: 'kill-1',
      type: 'kill',
      payload: { sessionId: 'wt@@stale', immediate: true }
    })

    expect(daemonLog.log).toHaveBeenCalledWith('session-exited', {
      sessionId: 'wt@@stale',
      pid: GONE_PID,
      cause: 'process-gone'
    })
    expect(daemonLog.log).not.toHaveBeenCalledWith('session-kill-failed', expect.anything())
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    await expect(
      daemon.requestRouter.route('control-1', { id: 'list-2', type: 'listSessions' })
    ).resolves.toEqual({ sessions: [] })
  })
})
