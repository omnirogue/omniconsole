import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider } from './local-pty-provider'
import type { IPtyProvider } from './types'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import * as processIdentityProbe from '../runtime/agent-session-process-identity-probe'
import { createPtySubprocess } from '../daemon/pty-subprocess'
import {
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'real process-owner launch gate',
  () => {
    let dir: string | undefined
    let provider: IPtyProvider | undefined
    let daemon: DaemonAdapterHarness | undefined
    let ptyId: string | undefined
    const originalUserDataPath = process.env.ORCA_USER_DATA_PATH

    afterEach(async () => {
      vi.restoreAllMocks()
      if (ptyId) {
        await provider?.shutdown(ptyId, { immediate: true })
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
      daemon = undefined
      ptyId = undefined
    })

    it('reaps a real local shell when launch gate preparation rejects', async () => {
      dir = mkdtempSync(join(tmpdir(), 'omni-owned-gate-reject-'))
      const localProvider = new LocalPtyProvider()
      provider = localProvider
      const id = 'real-local-gate-rejection'
      let spawnedPid = 0
      vi.spyOn(processIdentityProbe, 'readProcessStartTimeMs').mockImplementation(async (pid) => {
        spawnedPid = pid
        return null
      })
      await expect(
        provider.spawn({
          cols: 80,
          rows: 24,
          cwd: dir,
          sessionId: id,
          command: 'codex',
          launchGate: { version: 1, launchId: 'dispatch-reject' },
          env: { SHELL: '/bin/bash', HOME: dir }
        })
      ).rejects.toThrow('birth_unverifiable')
      expect(spawnedPid).toBeGreaterThan(0)
      expect(localProvider.hasPty(id)).toBe(false)
      expect(() => process.kill(spawnedPid, 0)).toThrow()
    })

    it.each(['local', 'daemon'] as const)(
      '%s holds startup and queued stdin through readiness and reattach',
      async (kind) => {
        dir = mkdtempSync(join(tmpdir(), 'omni-owned-gate-'))
        process.env.ORCA_USER_DATA_PATH = dir
        const marker = join(dir, 'executed.json')
        const queuedMarker = join(dir, 'queued')
        const script = join(dir, 'provider.cjs')
        const nodeExecutable = join(dir, 'node')
        symlinkSync(process.execPath, nodeExecutable)
        writeFileSync(
          script,
          `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({pid: process.pid})); setInterval(() => {}, 1000)\n`
        )
        if (kind === 'daemon') {
          daemon = await startDaemonAdapterHarness(createPtySubprocess)
          provider = daemon.adapter
        } else {
          provider = new LocalPtyProvider()
        }
        const opts = {
          cols: 80,
          rows: 24,
          cwd: dir,
          sessionId: `gate-${kind}`,
          commandDelivery: 'provider' as const,
          command: [nodeExecutable, script, marker]
            .map((arg) => quoteStartupArg(arg, 'posix'))
            .join(' '),
          launchGate: {
            version: 1,
            launchId: `dispatch-${kind}`,
            startupCommandMode: 'exec'
          } as const,
          env: {
            SHELL: '/bin/bash',
            HOME: dir,
            ORCA_POSIX_SHELL_STARTUP_COMMAND: `touch ${quoteStartupArg(marker, 'posix')}`
          }
        }
        let output = ''
        const unsubscribe = provider.onData((event) => {
          output += event.data
        })
        const result = await provider.spawn(opts)
        ptyId = result.id
        expect(result.launchGate).toMatchObject({
          state: 'closed',
          pid: result.pid,
          incarnationId: result.incarnationId,
          ptyId
        })
        expect(await readProcessStartTimeMs(result.pid!)).toBe(
          result.launchGate!.processStartTimeMs
        )
        // Exceeds the local ready fallback; daemon is exercised with its actual shell-ready marker.
        await delay(1900)
        provider.write(ptyId, `touch ${quoteStartupArg(queuedMarker, 'posix')}\n`)
        const replay = await provider.spawn(opts)
        expect(replay.launchGate).toEqual(result.launchGate)
        expect(existsSync(marker)).toBe(false)
        expect(existsSync(queuedMarker)).toBe(false)
        const release = {
          gate: result.launchGate!,
          startAcknowledgement: 'test-persisted-canonical-start'
        }
        await expect(
          provider.releaseLaunchGate!({
            ...release,
            gate: { ...release.gate, incarnationId: 'stale' }
          })
        ).rejects.toThrow('identity_mismatch')
        expect(existsSync(marker)).toBe(false)
        await provider.releaseLaunchGate!(release)
        await provider.releaseLaunchGate!(release)
        for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) {
          await delay(20)
        }
        expect(existsSync(marker), output).toBe(true)
        const launched = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number }
        if (release.gate.startupCommandMode === 'exec') {
          expect(launched.pid).toBe(result.pid)
        } else {
          expect(release.gate.reportsChildExitStatus).toBe(false)
        }
        expect(existsSync(queuedMarker)).toBe(false)
        process.stdout.write(
          `${JSON.stringify({
            kind,
            pid: result.pid,
            processStartTimeMs: release.gate.processStartTimeMs,
            providerPid: launched.pid,
            startupCommandMode: release.gate.startupCommandMode,
            reportsChildExitStatus: release.gate.reportsChildExitStatus
          })}\n`
        )
        unsubscribe()
      }
    )
  }
)
