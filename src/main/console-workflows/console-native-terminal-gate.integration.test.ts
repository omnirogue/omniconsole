import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import { listConsoleLocalExecutions } from './console-local-execution-state'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const fixtures: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    fixture.db.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function nativeFixture() {
  const fixture = await createConsoleLocalExecutionFixture()
  fixtures.push(fixture)
  vi.mocked(fixture.runtime.createTerminal).mockRestore()
  vi.mocked(fixture.runtime.releaseTerminalLaunchGate).mockRestore()
  vi.mocked(fixture.runtime.getTerminalProcessIncarnation).mockRestore()
  vi.spyOn(
    fixture.runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
      resolveAgentTerminalCreateOptions(
        workspace: unknown,
        options: Record<string, unknown>
      ): Promise<Record<string, unknown>>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'job-worktree',
    path: `${fixture.directory}/job`,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  vi.spyOn(
    fixture.runtime as unknown as {
      resolveAgentTerminalCreateOptions(
        workspace: unknown,
        options: Record<string, unknown>
      ): Promise<Record<string, unknown>>
    },
    'resolveAgentTerminalCreateOptions'
  ).mockImplementation(async (_workspace, options) => options)
  let pid = 700
  const held: PtyLaunchGateReceipt[] = []
  const releaseLaunchGate = vi.fn(async (input) => ({
    gateId: input.gate.gateId,
    state: 'released' as const,
    startAcknowledgement: input.startAcknowledgement
  }))
  const spawn = vi.fn(async (input) => {
    pid += 1
    if (!input.launchGate) {
      return { id: `pty-${pid}`, pid, incarnationId: randomUUID() }
    }
    const gate: PtyLaunchGateReceipt = {
      version: 1,
      state: 'closed',
      launchId: input.launchGate.launchId,
      gateId: randomUUID(),
      ptyId: `pty-${pid}`,
      incarnationId: randomUUID(),
      pid,
      processStartTimeMs: Date.now(),
      processKind: 'pty-shell',
      ptyRootPid: pid - 1,
      ptyRootProcessStartTimeMs: Date.now(),
      reportsChildExitStatus: true,
      exitObserver: 'macos-kqueue',
      startupCommandMode: 'exec'
    }
    held.push(gate)
    return { id: gate.ptyId, pid, incarnationId: gate.incarnationId, launchGate: gate }
  })
  fixture.runtime.setPtyController({
    spawn,
    releaseLaunchGate,
    readLaunchGateObservation: vi.fn(async (gate) => ({
      gateId: gate.gateId,
      ptyId: gate.ptyId,
      incarnationId: gate.incarnationId,
      pid: gate.pid,
      processStartTimeMs: gate.processStartTimeMs,
      state: 'live' as const,
      source: 'macos-kqueue' as const,
      startAcknowledgement: null
    })),
    adoptStablePane: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  fixture.runtime.attachWindow(1)
  return { ...fixture, spawn, held, releaseLaunchGate }
}

describe('Console admitted native terminal gate', () => {
  it('holds the actual PTY until the server start receipt is journaled and releases once', async () => {
    const fixture = await nativeFixture()
    vi.mocked(fixture.port.startProcess!).mockImplementation(async (input) => {
      expect(fixture.held).toHaveLength(1)
      expect(fixture.releaseLaunchGate).not.toHaveBeenCalled()
      return {
        ok: true,
        data: {
          ...input.binding,
          sessionId: 'ses_server',
          attemptId: 'attempt_server',
          inputDigest: input.inputDigest
        }
      }
    })
    const started = await fixture.service.start({
      jobId: fixture.job.id,
      workflowId: fixture.job.workflowId,
      approvedDigest: fixture.job.digest,
      worktree: 'id:source'
    })
    expect(started).toMatchObject({ ok: true })
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
    expect(fixture.releaseLaunchGate, JSON.stringify(started)).toHaveBeenCalledOnce()
    const record = listConsoleLocalExecutions(fixture.db, (await fixture.port.principal())!)[0]!
    const handshake = readConsoleJobProcessHandshake(fixture.db, {
      runId: record.run.id,
      dispatchId: record.worker.dispatch_id,
      principal: record.run.console_job_principal!,
      binding: record.binding
    })!
    expect(handshake).toMatchObject({
      gate: fixture.held[0],
      released: { event: { phase: 'released' } }
    })
    expect(handshake.startAcknowledgement).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it.each(['denied', 'stale'] as const)(
    'keeps the actual PTY held when the server acknowledgement is %s',
    async (kind) => {
      const fixture = await nativeFixture()
      vi.mocked(fixture.port.startProcess!).mockImplementation(async (input) =>
        kind === 'denied'
          ? { ok: false, error: { code: 'stale_claim', message: 'claim denied' } }
          : {
              ok: true,
              data: {
                ...input.binding,
                leaseGeneration: input.binding.leaseGeneration + 1,
                sessionId: 'ses_stale',
                attemptId: 'attempt_stale',
                inputDigest: input.inputDigest
              }
            }
      )
      const started = await fixture.service.start({
        jobId: fixture.job.id,
        workflowId: fixture.job.workflowId,
        approvedDigest: fixture.job.digest,
        worktree: 'id:source'
      })
      expect(started).toMatchObject({ ok: true })
      expect(fixture.held, JSON.stringify(started)).toHaveLength(1)
      expect(fixture.releaseLaunchGate).not.toHaveBeenCalled()
    }
  )
})
