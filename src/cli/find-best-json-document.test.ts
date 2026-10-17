/**
 * `omni find-best --json` must put exactly ONE parseable JSON document on stdout on every path.
 * Driven through main() because the second document came from the top-level error reporter, not
 * from the handler: a handler-only test cannot see it.
 */
import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/omni-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { LOCAL_WORKFLOW_METHODS } from '../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../shared/local-workflow-view'
import { RuntimeClientError } from './runtime/types'

const STARTED = {
  worktreeId: 'wt-1',
  conversationId: 'find-tab',
  executionId: '3f9a1c2e-0000-4000-8000-000000000000'
}

const WORKSPACE = '/work'
const OPERATION_ID = '3f9a1c2e-0000-4000-8000-000000000001'

function view(state: string, find?: Record<string, unknown>): LocalWorkflowView {
  return {
    executionId: STARTED.executionId,
    state,
    ...(state === 'completed'
      ? { result: { markdown: '## Best option: Crumb & Co', sources: [], coverage: [] } }
      : {}),
    graphRun: find ? { find } : undefined
  } as unknown as LocalWorkflowView
}

const TRAIL = { pool: 40, source: 'generated', top: 5, overall: [] }

/** Answers the reads the command makes; `views` is played in order, the last one repeating. */
function answerWith(views: LocalWorkflowView[], startError?: Error) {
  const queued = [...views]
  callMock.mockImplementation(async (method: string) => {
    if (method === 'worktree.list') {
      return {
        result: { worktrees: [{ id: 'wt-1', path: WORKSPACE }], totalCount: 1, truncated: false }
      }
    }
    if (method === LOCAL_WORKFLOW_METHODS.find) {
      if (startError) {
        throw startError
      }
      return { result: STARTED }
    }
    return { result: queued.length > 1 ? queued.shift() : queued[0] }
  })
}

describe('omni find-best --json writes one JSON document', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  /** Runs the command with stdout and stderr captured, and reports what each stream received. */
  async function find(argv: string[]): Promise<{ out: string; err: string; exitCode: number }> {
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    const out: string[] = []
    const err: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(`${String(line)}\n`)
    })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err.push(`${String(line)}\n`)
    })
    const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk))
      return true
    })
    try {
      // Only setTimeout is faked, so the deadline below stays on the real clock while the
      // follow loop's three-second waits are skipped.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let settled = false
      const done = main(argv, WORKSPACE).finally(() => {
        settled = true
      })
      // The command arms its next wait only after a read, and dispatch loads its handlers
      // lazily, so keep advancing until it ends rather than flushing once.
      const deadline = Date.now() + 15_000
      while (!settled && Date.now() < deadline) {
        await vi.advanceTimersByTimeAsync(3_000)
      }
      await done
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
      return { out: out.join(''), err: err.join(''), exitCode }
    } finally {
      vi.useRealTimers()
      for (const spy of [log, write, error, writeErr]) {
        spy.mockRestore()
      }
      process.exitCode = previousExitCode
    }
  }

  it('prints the report as one document when the run completes', async () => {
    answerWith([
      view('running', { stage: 'screen', ...TRAIL }),
      view('completed', { stage: 'done', ...TRAIL })
    ])
    const { out, err, exitCode } = await find([
      'find-best',
      'Name the bakery',
      '--json',
      '--operation-id',
      OPERATION_ID
    ])
    expect(JSON.parse(out)).toMatchObject({ ...STARTED, state: 'completed' })
    expect(err).toBe(`Workflow operation: ${OPERATION_ID} (keep --operation-id for retries).\n`)
    expect(exitCode).toBe(0)
  })

  it('reports a failed run inside that one document instead of adding an error document', async () => {
    answerWith([
      view('failed', { stage: 'failed', reason: 'JEV could not screen the 40 options.', ...TRAIL })
    ])
    const { out, exitCode } = await find(['find-best', 'x', '--json'])
    // JSON.parse refuses two concatenated documents, which is exactly the regression.
    expect(JSON.parse(out)).toMatchObject({
      state: 'failed',
      reason: 'JEV could not screen the 40 options.'
    })
    expect(out).not.toContain('"ok": false')
    expect(exitCode).toBe(1)
  })

  it('reports a stopped and a recovery-required run the same way', async () => {
    for (const state of ['cancelled', 'recovery_required']) {
      answerWith([
        view(state, { stage: 'failed', reason: `Find the best ended ${state}.`, ...TRAIL })
      ])
      const { out, exitCode } = await find(['find-best', 'x', '--json'])
      expect(JSON.parse(out)).toMatchObject({ state })
      expect(exitCode).toBe(1)
    }
  })

  it('prints only the started run for --no-follow', async () => {
    answerWith([view('running', { stage: 'options', ...TRAIL })])
    const { out, exitCode } = await find(['find-best', 'x', '--json', '--no-follow'])
    expect(JSON.parse(out)).toEqual(STARTED)
    expect(callMock).not.toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.show, expect.anything())
    expect(exitCode).toBe(0)
  })

  it('prints one error document when the run never starts', async () => {
    answerWith([], new RuntimeClientError('runtime_unavailable', 'OmniConsole is not running.'))
    const { out, err, exitCode } = await find([
      'find-best',
      'x',
      '--json',
      '--operation-id',
      OPERATION_ID
    ])
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: `OmniConsole is not running. If retrying this request, keep --operation-id ${OPERATION_ID} to use the same workflow.`
      }
    })
    expect(err).toBe(`Workflow operation: ${OPERATION_ID} (keep --operation-id for retries).\n`)
    expect(exitCode).toBe(1)
  })

  it('prints one error document when a flag is wrong, and nothing else', async () => {
    answerWith([view('completed', { stage: 'done', ...TRAIL })])
    const { out, exitCode } = await find(['find-best', 'x', '--keep', 'ten', '--json'])
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(exitCode).toBe(1)
  })

  it('keeps progress off stdout while it follows without --json', async () => {
    answerWith([
      view('running', { stage: 'screen', ...TRAIL }),
      view('completed', { stage: 'done', ...TRAIL })
    ])
    const { out, err } = await find(['find-best', 'Name the bakery'])
    expect(err).toContain('JEV is scoring 40 options…')
    expect(out).toBe('## Best option: Crumb & Co\n')
  })
})
