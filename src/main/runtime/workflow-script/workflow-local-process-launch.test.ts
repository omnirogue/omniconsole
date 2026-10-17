import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { WORKFLOW_CALL_STALL_MS } from './workflow-call-timeout'
import { workflowCallStalledAfter } from './workflow-native-result'

const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function setup(
  script = 'process.stdin.pipe(process.stdout)',
  extra: Partial<Parameters<typeof createWorkflowLocalProcessLaunch>[0]> = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-process-'))
  directories.push(directory)
  const launch = createWorkflowLocalProcessLaunch({
    directory,
    hostId: 'fixture-host',
    ownerIncarnation: 'fixture-owner',
    executionId: 'execution',
    fence: 1,
    timeoutMs: 3000,
    maxOutputBytes: 1024,
    command: () => ({ program: process.execPath, args: ['-e', script], input: 'frozen evidence' }),
    ...extra
  })
  const input = {
    attemptId: 'attempt-1',
    ordinal: 1,
    problems: null,
    signal: new AbortController().signal,
    recordPreparation: vi.fn(),
    recordLaunch: vi.fn(),
    recordNoLaunch: vi.fn(),
    call: {
      id: 'answer/1',
      seatId: 'seat',
      prompt: 'frozen evidence',
      dependencies: [],
      schema: { type: 'object' as const },
      validateSemantics: () => null
    }
  }
  return { directory, launch, input }
}

describe.skipIf(process.platform === 'win32')('workflow local process receipts', () => {
  it('does not spawn when preparation persistence fails', async () => {
    const { directory, launch, input } = setup()
    input.recordPreparation.mockImplementation((identity) => {
      expect(identity).toMatchObject({
        executionId: 'execution',
        attemptId: input.attemptId,
        callId: input.call.id
      })
      expect(() => readFileSync(join(directory, input.attemptId, 'launch.json'))).toThrow()
      throw new Error('Checkpoint write failed')
    })
    await expect(launch(input)).rejects.toThrow('Checkpoint write failed')
    expect(input.recordLaunch).not.toHaveBeenCalled()
    expect(() => readFileSync(join(directory, input.attemptId, 'terminal.json'))).toThrow()
  })

  it('publishes launch identity before input and persists bounded output after group closure', async () => {
    const { directory, launch, input } = setup()
    input.recordLaunch.mockImplementation((path) => {
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      expect(receipt).toMatchObject({
        attemptId: input.attemptId,
        executionId: 'execution',
        fence: 1
      })
      expect(receipt.pid).toBeGreaterThan(0)
      expect(() => process.kill(receipt.pid, 0)).not.toThrow()
    })
    const answer = await launch(input)
    expect(answer.result.stdout).toBe('frozen evidence')
    expect(input.recordLaunch).toHaveBeenCalledOnce()
    const terminal = JSON.parse(
      readFileSync(join(directory, input.attemptId, 'terminal.json'), 'utf8')
    )
    expect(terminal).toMatchObject({
      liveness: 'exited',
      result: answer.result,
      groupCleanupRequired: false
    })
    const persisted = readFileSync(join(directory, input.attemptId, 'launch.json'), 'utf8')
    expect(persisted).not.toContain('frozen evidence')
    await expect(launch(input)).rejects.toThrow('EEXIST')
    expect(input.recordLaunch).toHaveBeenCalledOnce()
  })

  it('terminates when launch publication fails, without issuing a terminal receipt', async () => {
    const { directory, launch, input } = setup('setInterval(() => {}, 1000)')
    let pid = 0
    input.recordLaunch.mockImplementation((path) => {
      pid = JSON.parse(readFileSync(path, 'utf8')).pid
      throw new Error('Fence lost')
    })
    await expect(launch(input)).rejects.toThrow('Fence lost')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(() => readFileSync(join(directory, input.attemptId, 'terminal.json'))).toThrow()
  })

  it('rejects pre-cancelled admission before creating an attempt directory', async () => {
    const { directory, launch, input } = setup()
    const controller = new AbortController()
    controller.abort(new Error('Stopped'))
    await expect(launch({ ...input, signal: controller.signal })).rejects.toThrow('Stopped')
    expect(input.recordLaunch).not.toHaveBeenCalled()
    expect(() => readFileSync(join(directory, input.attemptId, 'launch.json'))).toThrow()
  })

  it('checks descendants that close inherited output before accepting an exit receipt', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid));
      child.unref();
    `
    const { directory, launch, input } = setup(script)
    const answer = await launch(input)
    const terminal = JSON.parse(
      readFileSync(join(directory, input.attemptId, 'terminal.json'), 'utf8')
    )
    expect(terminal.groupCleanupRequired).toBe(true)
    const descendant = Number(answer.result.stdout)
    expect(descendant).toBeGreaterThan(0)
    // The adapter's process-table check also handles unreaped zombies on Linux.
    if (process.platform === 'darwin') {
      expect(() => process.kill(descendant, 0)).toThrow()
    }
  })

  it('stores filtered lines, streams every line live and reports spawn and exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-process-'))
    directories.push(directory)
    const seen: string[] = []
    const events: string[] = []
    // Raw output is larger than the cap; only the filtered form must fit.
    const script = `process.stdout.write('noise:' + 'x'.repeat(4096) + '\\nkeep\\ntail')`
    const launch = createWorkflowLocalProcessLaunch({
      directory,
      hostId: 'fixture-host',
      ownerIncarnation: 'fixture-owner',
      executionId: 'execution',
      fence: 1,
      timeoutMs: 3000,
      maxOutputBytes: 1024,
      command: () => ({ program: process.execPath, args: ['-e', script] }),
      storeLine: (line) => (line.startsWith('noise:') ? null : line),
      onLine: (line) => seen.push(line.slice(0, 6)),
      onSpawned: () => events.push('spawned'),
      onExited: () => events.push('exited')
    })
    const { input } = setup()
    const answer = await launch({ ...input, attemptId: 'attempt-filtered' })
    expect(answer.result.stdout).toBe('keep\ntail')
    expect(answer.result.stdoutTruncated).toBeUndefined()
    expect(seen).toEqual(['noise:', 'keep', 'tail'])
    expect(events).toEqual(['spawned', 'exited'])
    const terminal = JSON.parse(
      readFileSync(join(directory, 'attempt-filtered', 'terminal.json'), 'utf8')
    )
    expect(terminal.result.stdout).toBe('keep\ntail')
  })
})

describe.skipIf(process.platform === 'win32')('workflow call stall deadline', () => {
  // Fake time jumps the deadline; it also follows real time so the group checks still run.
  const fakeClock = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })

  it('ends a silent call with its whole process group and records the stall', async () => {
    fakeClock()
    // The CLI starts a helper in its own group, says one line and then goes silent.
    const script = `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(helper.pid + '\\n');
      setInterval(() => {}, 1000);
    `
    const said: string[] = []
    const { directory, launch, input } = setup(script, {
      timeoutMs: 2 * WORKFLOW_CALL_STALL_MS,
      stallMs: WORKFLOW_CALL_STALL_MS,
      onLine: (line) => said.push(line)
    })
    const answer = launch(input)
    await vi.waitFor(() => expect(said).toHaveLength(1), { timeout: 5000 })
    const helper = Number(said[0])
    vi.advanceTimersByTime(WORKFLOW_CALL_STALL_MS - 1000)
    expect(() => process.kill(helper, 0)).not.toThrow()
    vi.advanceTimersByTime(1000)
    const { result } = await answer
    expect(workflowCallStalledAfter(result)).toBe(WORKFLOW_CALL_STALL_MS)
    expect(result.timedOut).toBe(false)
    // The adapter's process-table check also handles unreaped zombies on Linux.
    if (process.platform === 'darwin') {
      expect(() => process.kill(helper, 0)).toThrow()
    }
    const terminal = JSON.parse(
      readFileSync(join(directory, input.attemptId, 'terminal.json'), 'utf8')
    )
    expect(terminal.result.stalledAfterMs).toBe(WORKFLOW_CALL_STALL_MS)
  })

  it('restarts the deadline on every output, so a call that keeps talking is never ended', async () => {
    fakeClock()
    const script = `
      process.stdout.write('one\\n');
      setTimeout(() => {
        process.stdout.write('two\\n');
        setTimeout(() => process.exit(0), 300);
      }, 300);
    `
    const said: string[] = []
    const { launch, input } = setup(script, {
      timeoutMs: 3 * WORKFLOW_CALL_STALL_MS,
      stallMs: WORKFLOW_CALL_STALL_MS,
      onLine: (line) => said.push(line)
    })
    const answer = launch(input)
    await vi.waitFor(() => expect(said).toEqual(['one']), { timeout: 5000 })
    vi.advanceTimersByTime(WORKFLOW_CALL_STALL_MS - 5000)
    await vi.waitFor(() => expect(said).toEqual(['one', 'two']), { timeout: 5000 })
    // Past the first line's deadline, but within the second's.
    vi.advanceTimersByTime(WORKFLOW_CALL_STALL_MS - 5000)
    const { result } = await answer
    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(workflowCallStalledAfter(result)).toBeUndefined()
  })
})
