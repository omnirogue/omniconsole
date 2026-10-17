import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider, _resetLocalPtyProviderStateForTest } from './local-pty-provider'
import type { IPtyProvider } from './types'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import type { PtyLaunchGateObservation } from '../../shared/pty-launch-gate'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { createPtySubprocess } from '../daemon/pty-subprocess'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { runProcess } from '../../shared/child-process/run-process'
import { mintConsoleLaunchGate } from '../pty/console-launch-authority'
import {
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const helper = vi.hoisted(() => ({ executable: null as string | null }))
vi.mock('./macos-pty-process-observer-path', () => ({
  resolveMacosPtyProcessObserver: () => helper.executable
}))

describe.skipIf(process.platform !== 'darwin')('Mac registered shell-child gate', () => {
  let helperDir: string
  let nodeExecutable: string
  beforeAll(async () => {
    helperDir = mkdtempSync(join(tmpdir(), 'omni-gate-observer-binary-'))
    nodeExecutable = join(helperDir, 'node')
    symlinkSync(process.execPath, nodeExecutable)
    const executable = join(helperDir, 'omni-pty-process-observer')
    const build = await runProcess({
      program: process.execPath,
      args: [
        join(process.cwd(), 'config/scripts/build-pty-process-observer-macos.mjs'),
        '--single-arch',
        '--output',
        executable
      ]
    })
    expect(build.code, build.stderr).toBe(0)
    helper.executable = executable
  })
  afterAll(() => {
    if (helperDir) {
      rmSync(helperDir, { recursive: true, force: true })
    }
  })
  let dir: string | undefined
  let provider: IPtyProvider | undefined
  let daemon: DaemonAdapterHarness | undefined
  let ptyId: string | undefined
  const originalUserDataPath = process.env.ORCA_USER_DATA_PATH
  afterEach(async () => {
    if (ptyId) {
      await provider?.shutdown(ptyId, { immediate: true }).catch(() => {})
    }
    daemon?.adapter.dispose()
    await daemon?.server.shutdown()
    if (daemon) {
      rmSync(daemon.dir, { recursive: true, force: true })
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = originalUserDataPath
    }
    _resetLocalPtyProviderStateForTest()
    daemon = undefined
    ptyId = undefined
  })

  it('refuses a person change after async validation before committing any native spawn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'omni-mac-revoked-gate-'))
    process.env.ORCA_USER_DATA_PATH = dir
    provider = new LocalPtyProvider()
    const onPtySpawnCommitted = vi.fn()
    const validate = vi.fn(async () => {})
    const gate = mintConsoleLaunchGate({
      taskId: 'btk_nativegate',
      worktreeId: 'console-workspace',
      cwd: dir,
      validate,
      assertCurrent: () => {
        throw new Error('signed-in person changed')
      }
    })
    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        cwd: dir,
        worktreeId: 'console-workspace',
        command: `${quoteStartupArg(nodeExecutable, 'posix')} --version`,
        launchGate: gate,
        env: { SHELL: '/bin/bash', HOME: dir, OMNI_TASK_ID: 'btk_nativegate' },
        onPtySpawnCommitted
      })
    ).rejects.toThrow('signed-in person changed')
    expect(validate).toHaveBeenCalledOnce()
    expect(onPtySpawnCommitted).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it.each(['local', 'daemon'] as const)(
    '%s rejects unsupported identity before committing a native spawn',
    async (kind) => {
      dir = mkdtempSync(join(tmpdir(), 'omni-mac-unsupported-gate-'))
      process.env.ORCA_USER_DATA_PATH = dir
      if (kind === 'daemon') {
        daemon = await startDaemonAdapterHarness(createPtySubprocess)
        provider = daemon.adapter
      } else {
        provider = new LocalPtyProvider()
      }
      const onPtySpawnCommitted = vi.fn()
      await expect(
        provider.spawn({
          cols: 80,
          rows: 24,
          cwd: dir,
          command: `${quoteStartupArg(nodeExecutable, 'posix')} --version`,
          launchGate: {
            version: 1,
            launchId: 'unsupported-shell',
            startupCommandMode: 'exec',
            processObservation: 'required'
          },
          env: { SHELL: '/bin/sh', HOME: dir },
          onPtySpawnCommitted
        })
      ).rejects.toThrow('pty_launch_gate_shell_identity_unavailable')
      expect(onPtySpawnCommitted).not.toHaveBeenCalled()
      expect(await provider.listProcesses()).toEqual([])
    }
  )

  it.each([
    { kind: 'console', exitCode: 0, signal: null },
    { kind: 'local', exitCode: 0, signal: null },
    { kind: 'daemon', exitCode: 37, signal: null },
    { kind: 'local', exitCode: null, signal: 9 }
  ] as const)(
    '$kind returns the actual child status $exitCode/$signal behind login',
    async ({ kind, exitCode, signal }) => {
      dir = mkdtempSync(join(tmpdir(), 'omni-mac-child-gate-'))
      process.env.ORCA_USER_DATA_PATH = dir
      const marker = join(dir, 'provider.json')
      const queuedMarker = join(dir, 'queued')
      const fixture = join(dir, 'provider.cjs')
      writeFileSync(
        fixture,
        `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,taskId:process.env.OMNI_TASK_ID})); setTimeout(() => ${signal ? "process.kill(process.pid, 'SIGKILL')" : `process.exit(${exitCode})`}, 250);\n`
      )
      if (kind === 'daemon') {
        daemon = await startDaemonAdapterHarness(createPtySubprocess)
        provider = daemon.adapter
      } else {
        provider = new LocalPtyProvider()
      }
      expect(provider.supportsLaunchGateObservation?.()).toBe(true)
      const options = {
        cols: 80,
        rows: 24,
        cwd: dir,
        ...(kind === 'console'
          ? { worktreeId: 'console-workspace' }
          : { sessionId: `mac-gate-${kind}` }),
        commandDelivery: 'provider' as const,
        command: [nodeExecutable, fixture, marker]
          .map((arg) => quoteStartupArg(arg, 'posix'))
          .join(' '),
        launchGate:
          kind === 'console'
            ? mintConsoleLaunchGate({
                taskId: 'btk_nativegate',
                worktreeId: 'console-workspace',
                cwd: dir,
                validate: async () => {},
                assertCurrent: () => {}
              })
            : ({
                version: 1,
                launchId: `mac-${kind}`,
                startupCommandMode: 'exec',
                processObservation: 'required'
              } as const),
        env: {
          SHELL: '/bin/bash',
          HOME: dir,
          ...(kind === 'console' ? { OMNI_TASK_ID: 'btk_nativegate' } : {})
        }
      }
      const prepared = await provider.spawn(options)
      ptyId = prepared.id
      const gate = prepared.launchGate!
      expect(gate).toMatchObject({
        state: 'closed',
        processKind: 'pty-shell',
        startupCommandMode: 'exec',
        reportsChildExitStatus: true,
        exitObserver: 'macos-kqueue',
        ptyRootPid: prepared.pid,
        incarnationId: prepared.incarnationId
      })
      expect(gate.pid).not.toBe(prepared.pid)
      expect(Math.floor(gate.processStartTimeMs / 1000) * 1000).toBe(
        await readProcessStartTimeMs(gate.pid)
      )
      provider.write(ptyId, `touch ${quoteStartupArg(queuedMarker, 'posix')}\n`)
      await delay(1700)
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(queuedMarker)).toBe(false)
      if (kind === 'console') {
        await expect(provider.spawn(options)).rejects.toMatchObject({ code: 'consumer_fenced' })
      } else {
        expect((await provider.spawn(options)).launchGate).toEqual(gate)
      }
      expect(await provider.readLaunchGateObservation!(gate)).toMatchObject({
        state: 'live',
        startAcknowledgement: null
      })
      await expect(
        provider.releaseLaunchGate!({
          gate: { ...gate, processStartTimeMs: gate.processStartTimeMs + 1 },
          startAcknowledgement: 'persisted-start'
        })
      ).rejects.toThrow('identity_mismatch')
      const release = { gate, startAcknowledgement: 'persisted-start' }
      await provider.releaseLaunchGate!(release)
      await provider.releaseLaunchGate!(release)
      let observed: PtyLaunchGateObservation
      for (let attempt = 0; ; attempt++) {
        observed = await provider.readLaunchGateObservation!(gate)
        if (observed.state === 'exited' || attempt === 100) {
          break
        }
        await delay(20)
      }
      process.stdout.write(`${JSON.stringify({ kind, gate, observed })}\n`)
      expect(JSON.parse(readFileSync(marker, 'utf8')).pid).toBe(gate.pid)
      if (kind === 'console') {
        expect(JSON.parse(readFileSync(marker, 'utf8')).taskId).toBe('btk_nativegate')
      }
      expect(observed).toMatchObject({
        state: 'exited',
        source: 'macos-kqueue',
        pid: gate.pid,
        processStartTimeMs: gate.processStartTimeMs,
        exitCode,
        signal,
        startAcknowledgement: 'persisted-start'
      })
      expect(existsSync(queuedMarker)).toBe(false)
      if (daemon) {
        const reconnected = new DaemonPtyAdapter({
          socketPath: daemon.socketPath,
          tokenPath: daemon.tokenPath
        })
        try {
          expect(await reconnected.readLaunchGateObservation(gate)).toEqual(observed)
          await daemon.adapter.disconnectOnly()
          expect(await reconnected.readLaunchGateObservation(gate)).toEqual(observed)
        } finally {
          reconnected.dispose()
        }
      }
    }
  )
})
