import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PtyLaunchGateReceipt, PtyLaunchGateRequest } from '../../shared/pty-launch-gate'
import { OrcaRuntimeService } from './omni-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function fixture(connectionId: string | null = null) {
  const runtime = new OrcaRuntimeService()
  const request: PtyLaunchGateRequest = {
    version: 1,
    launchId: randomUUID(),
    startupCommandMode: 'exec'
  }
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: request.launchId,
    gateId: randomUUID(),
    ptyId: 'gate-pty',
    incarnationId: randomUUID(),
    pid: 431,
    processStartTimeMs: 1788900000000,
    processKind: 'pty-root',
    reportsChildExitStatus: true,
    startupCommandMode: 'exec'
  }
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'folder-gate',
    path: '/tmp/gate',
    connectionId,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn(async () => ({
    id: gate.ptyId,
    pid: gate.pid,
    incarnationId: gate.incarnationId,
    launchGate: gate
  }))
  const releaseLaunchGate = vi.fn(async (input) => ({
    gateId: input.gate.gateId,
    state: 'released' as const,
    startAcknowledgement: input.startAcknowledgement
  }))
  const adoptStablePane = vi.fn()
  const controller = {
    spawn,
    releaseLaunchGate,
    adoptStablePane,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  runtime.attachWindow(1)
  return { runtime, request, gate, spawn, releaseLaunchGate, adoptStablePane, controller }
}

describe('main runtime held terminal creation', () => {
  it('preserves the host receipt while startup and renderer adoption never release the gate', async () => {
    const { runtime, request, gate, spawn, releaseLaunchGate, adoptStablePane } = fixture()
    const terminal = await runtime.createTerminal('id:folder-gate', {
      command: 'codex',
      launchGate: request,
      surfaceOwner: false
    })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ launchGate: request }))
    expect(terminal.launchGate).toEqual(gate)
    expect(terminal.processId).toBe(gate.pid)
    expect(adoptStablePane).not.toHaveBeenCalled()
    expect(releaseLaunchGate).not.toHaveBeenCalled()
    await runtime.releaseTerminalLaunchGate(terminal.handle, {
      gate,
      startAcknowledgement: 'committed-start-receipt'
    })
    expect(releaseLaunchGate).toHaveBeenCalledExactlyOnceWith({
      gate,
      startAcknowledgement: 'committed-start-receipt'
    })
  })

  it('refuses older controllers before they can ignore a launch hold', async () => {
    const { runtime, request, controller, spawn } = fixture()
    runtime.setPtyController({ ...controller, releaseLaunchGate: undefined })
    await expect(
      runtime.createTerminal('id:folder-gate', { command: 'codex', launchGate: request })
    ).rejects.toThrow('pty_launch_gate_requires_fresh_local_process')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a required process observer before an older controller can spawn', async () => {
    const { runtime, request, spawn } = fixture()
    await expect(
      runtime.createTerminal('id:folder-gate', {
        command: 'codex',
        launchGate: { ...request, processObservation: 'required' }
      })
    ).rejects.toThrow('pty_launch_gate_requires_fresh_local_process')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports missing observer contact as unverifiable without spawning or releasing', async () => {
    const { runtime, gate, spawn, releaseLaunchGate } = fixture()
    expect(await runtime.readTerminalLaunchGateObservation(gate)).toMatchObject({
      state: 'unverifiable',
      gateId: gate.gateId,
      pid: gate.pid,
      processStartTimeMs: gate.processStartTimeMs
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(releaseLaunchGate).not.toHaveBeenCalled()
  })

  it('refuses an SSH host before local process creation', async () => {
    const { runtime, request, spawn } = fixture('ssh-connection')
    await expect(
      runtime.createTerminal('id:folder-gate', { command: 'codex', launchGate: request })
    ).rejects.toThrow('pty_launch_gate_unavailable')
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([{ rendererBacked: true }, { sessionId: 'restored-session' }, { tabId: randomUUID() }])(
    'refuses an incompatible create path before spawn: %j',
    async (options) => {
      const { runtime, request, spawn } = fixture()
      await expect(
        runtime.createTerminal('id:folder-gate', {
          ...options,
          command: 'codex',
          launchGate: request
        })
      ).rejects.toThrow('pty_launch_gate_requires_fresh_local_process')
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it('refuses release when the current process incarnation differs from the receipt', async () => {
    const { runtime, request, gate, releaseLaunchGate } = fixture()
    const terminal = await runtime.createTerminal('id:folder-gate', {
      command: 'codex',
      launchGate: request
    })
    await expect(
      runtime.releaseTerminalLaunchGate(terminal.handle, {
        gate: { ...gate, incarnationId: randomUUID() },
        startAcknowledgement: 'committed-start-receipt'
      })
    ).rejects.toThrow('pty_launch_gate_identity_unverifiable')
    expect(releaseLaunchGate).not.toHaveBeenCalled()
  })
})
