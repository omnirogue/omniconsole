import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { resolveProcessExitCause } from '../../../../shared/terminal-exit-cause'
import { quoteStartupArg } from '../../../../shared/tui-agent-startup-shell'
import { readProcessStartTimeMs } from '../../agent-session-process-identity-probe'
import { createWorkerNaturalExitFixture } from './orchestration-worker-natural-exit.test-fixture'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'

const provider = `printf '__PROVIDER_PID__:%s\\n' "$$"; read -r input; exit 37`

async function observe(script: string): Promise<{
  pid: number
  output: string
  rootWasLiveAfterProviderExit: boolean
  exit: { exitCode: number; signal?: number }
}> {
  const proc = pty.spawn('/bin/sh', ['-c', script], {
    cols: 100,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  let output = ''
  let sentInput = false
  let sentCleanup = false
  let exited = false
  let rootWasLiveAfterProviderExit = false
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`PTY fixture timed out: ${output}`))
    }, 3_000)
    proc.onData((data) => {
      output += data
      if (!sentInput && /__PROVIDER_PID__:\d+\r?\n/.test(output)) {
        sentInput = true
        proc.write('done\n')
      }
      if (!sentCleanup && output.includes('__PROVIDER_RETURNED__:37')) {
        rootWasLiveAfterProviderExit = !exited
        sentCleanup = true
        proc.write('cleanup\n')
      }
    })
    proc.onExit((exit) => {
      exited = true
      clearTimeout(timeout)
      resolve({ pid: proc.pid, output, rootWasLiveAfterProviderExit, exit })
    })
  })
}

describe.skipIf(process.platform === 'win32')(
  'settled worker process identity on a real PTY',
  () => {
    it('returns the physical natural exit for the registered PID and birth', async () => {
      const f = createWorkerNaturalExitFixture()
      const proc = pty.spawn(
        '/bin/sh',
        ['-c', `printf '__EXIT_READY__\\n'; read -r request; [ "$request" = /exit ]`],
        {
          cols: 100,
          rows: 24,
          cwd: process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color' }
        }
      )
      let exited = false
      let ready!: () => void
      let observed!: (wait: RuntimeTerminalWait) => void
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve
      })
      const exitPromise = new Promise<RuntimeTerminalWait>((resolve) => {
        observed = resolve
      })
      let output = ''
      proc.onData((data) => {
        output += data
        if (output.includes('__EXIT_READY__')) {
          ready()
        }
      })
      proc.onExit((event) => {
        exited = true
        const wait = f.exit(event.exitCode, resolveProcessExitCause(event))
        f.state.observation!.exit!.observedAt = new Date().toISOString()
        observed(wait)
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Natural exit PTY timed out: ${output}`)),
          3_000
        )
      })
      try {
        await Promise.race([readyPromise, deadline])
        const birth = await readProcessStartTimeMs(proc.pid)
        expect(birth).not.toBeNull()
        f.gate.pid = proc.pid
        f.gate.processStartTimeMs = birth!
        f.state.observation!.gate = { ...f.gate }
        f.observeProcess.mockImplementation(async () => {
          if (!exited && (await readProcessStartTimeMs(proc.pid)) !== birth && !exited) {
            return null
          }
          return f.state.observation
        })
        f.runtime.sendTerminal.mockImplementation(async (_handle, action, options) => {
          await options.beforeWrite(f.gate.ptyId)
          options.reserveWrite(f.gate.ptyId)
          proc.write(`${action.text}\r`)
          return { handle: 'term-1', accepted: true, bytesWritten: 6 }
        })
        f.runtime.waitForTerminal.mockImplementation(async (_handle, options) =>
          options.condition === 'exit'
            ? exitPromise
            : {
                handle: 'term-1',
                condition: 'tui-idle',
                satisfied: true,
                status: 'running',
                exitCode: null
              }
        )
        const result = await Promise.race([f.run(), deadline])
        expect(result).toMatchObject({
          status: 'exited',
          gate: { pid: proc.pid, processStartTimeMs: birth },
          exitCode: 0,
          exitCause: { kind: 'exited', exitCode: 0 }
        })
        expect(exited).toBe(true)
        expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
      } finally {
        clearTimeout(timeout)
        if (!exited) {
          proc.kill()
        }
      }
    })

    it('a containing shell can report zero after its provider failed', async () => {
      const result = await observe(
        `/bin/sh -c ${quoteStartupArg(provider, 'posix')}; printf '__PROVIDER_RETURNED__:%s\\n' "$?"; read -r cleanup; exit 0`
      )
      const providerPid = Number(/__PROVIDER_PID__:(\d+)/.exec(result.output)?.[1])
      expect(providerPid).toBeGreaterThan(0)
      expect(providerPid).not.toBe(result.pid)
      expect(result.rootWasLiveAfterProviderExit).toBe(true)
      expect(resolveProcessExitCause(result.exit)).toEqual({ kind: 'exited', exitCode: 0 })
      console.info('Containing shell counterexample:', {
        rootPid: result.pid,
        providerPid,
        providerExitCode: 37,
        rootExit: result.exit
      })
    })

    it('exec preserves the registered PID and the actual provider exit status', async () => {
      const result = await observe(`exec /bin/sh -c ${quoteStartupArg(provider, 'posix')}`)
      expect(Number(/__PROVIDER_PID__:(\d+)/.exec(result.output)?.[1])).toBe(result.pid)
      expect(result.rootWasLiveAfterProviderExit).toBe(false)
      expect(resolveProcessExitCause(result.exit)).toEqual({ kind: 'exited', exitCode: 37 })
    })
  }
)
