import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { RuntimeClientError } from '../runtime-client'
import { runtimeCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowRunStatus
} from '../../shared/local-workflow-rpc'
import { FIND_BEST_HANDLERS } from './find-best'
import { runRequestFromFlags } from './workflow-run'
import { WORKFLOW_STATUS_HANDLERS, workflowStatusLines } from './workflow-status'

const EXECUTION = '3f9a1c2e-0000-4000-8000-000000000000'
const STARTED = { worktreeId: 'wt-1', conversationId: 'council-tab', executionId: EXECUTION }
const WORDS = 'make it so we can launch the workflows on other computers'
const PLACEMENT = {
  runsOn: 'fleet' as const,
  mode: 'dispatched-seats' as const,
  choice: 'named' as const,
  host: {
    name: 'mw0004',
    machine: 'mw0004',
    cores: 10,
    loadPerCore: 0.11,
    readAt: Date.UTC(2026, 8, 30, 17, 3),
    ssh: 'mw0004'
  },
  dispatch: {
    root: '/Users/cloud/.omni-fleet/workflow-runs/r1',
    home: '/Users/cloud',
    hidden: []
  }
}
const STATUS: LocalWorkflowRunStatus = {
  ...STARTED,
  preset: 'council',
  state: 'running',
  prompt: 'Which cache?',
  startedAt: 1,
  placement: PLACEMENT,
  requestedBy: 'Sal',
  request: WORDS,
  seats: [
    {
      callId: 'answers/seat-1',
      attempt: 1,
      state: 'accepted',
      route: 'codex',
      model: 'gpt-5.6-sol',
      host: 'mw0004',
      remoteDirectory: '/Users/cloud/.omni-fleet/workflow-runs/r1/attempts/a1',
      sessionId: '0199a1b2-0000-7000-8000-000000000001'
    }
  ]
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      argv,
      COMMAND_SPECS.map((spec) => spec.path)
    )
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

function client(start: () => unknown = () => ({ result: STARTED })) {
  return vi.fn(async (method: string) => {
    if (method === 'worktree.list') {
      return { result: { worktrees: [{ id: 'wt-1', path: '/work' }] } }
    }
    if (method === LOCAL_WORKFLOW_METHODS.run) {
      return start()
    }
    if (method === LOCAL_WORKFLOW_METHODS.runStatus) {
      return { result: STATUS }
    }
    throw new Error(`unexpected ${method}`)
  })
}

function run(argv: string[], rpc: ReturnType<typeof client>, json = true) {
  const parsed = parse(argv)
  const handlers = { ...FIND_BEST_HANDLERS, ...WORKFLOW_STATUS_HANDLERS }
  return handlers[parsed.commandPath.join(' ')]!({
    client: { call: rpc, isRemote: false },
    flags: parsed.flags,
    cwd: '/work',
    json
  } as unknown as HandlerContext)
}

const COUNCIL = ['workflow', 'run', '--template', 'council', '--prompt', 'Which cache?']
let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('omni workflow run on a named host, for a person', () => {
  it('sends the host, the force reason and who asked with the request', async () => {
    const flags = parse([
      ...COUNCIL,
      '--host',
      'mw0004',
      '--force-host',
      'batch ends soon',
      '--requested-by',
      'Sal',
      '--request',
      WORDS
    ]).flags
    expect(await runRequestFromFlags(flags, '/work')).toMatchObject({
      runsOn: 'fleet',
      host: 'mw0004',
      forceHost: 'batch ends soon',
      requestedBy: 'Sal',
      request: WORDS
    })
  })

  it('names flag mistakes before anything starts', async () => {
    await expect(
      runRequestFromFlags(parse([...COUNCIL, '--force-host', 'x']).flags, '/work')
    ).rejects.toThrow('--force-host needs --host <name>.')
    await expect(
      runRequestFromFlags(
        parse([...COUNCIL, '--host', 'mw0004', '--runs-on', 'local']).flags,
        '/work'
      )
    ).rejects.toThrow('--host names a fleet host; it cannot go with --runs-on local.')
    await expect(
      runRequestFromFlags(parse([...COUNCIL, '--requested-by', 'Sal']).flags, '/work')
    ).rejects.toThrow('Give --requested-by "<person>" and --request "<their words>" together.')
  })

  it('prints the run id and its frozen placement in the JSON envelope', async () => {
    const rpc = client()
    await run(
      [...COUNCIL, '--host', 'mw0004', '--requested-by', 'Sal', '--request', WORDS, '--no-follow'],
      rpc
    )
    const printed = JSON.parse(log.mock.calls[0]![0] as string)
    expect(printed).toEqual({
      started: true,
      ...STARTED,
      state: 'running',
      placement: PLACEMENT,
      requestedBy: 'Sal',
      request: WORDS
    })
  })

  it('prints a refused Start with its reason in the same envelope, exiting 1', async () => {
    const reason =
      'mw0004 is too busy for this run (0.91 load per core, over 0.8). Choose another host, or force it with a reason.'
    const rpc = client(() => {
      throw new RuntimeClientError('runtime_error', reason)
    })
    await run([...COUNCIL, '--host', 'mw0004', '--no-follow'], rpc)
    const printed = JSON.parse(log.mock.calls[0]![0] as string)
    expect(printed.started).toBe(false)
    expect(printed.template).toBe('council')
    expect(printed.reason).toContain(reason)
    expect(process.exitCode).toBe(1)
  })

  it('never reports an unanswered Start as refused', async () => {
    const rpc = client(() => {
      throw new RuntimeClientError('timeout', 'The runtime did not answer in time.')
    })
    await expect(run([...COUNCIL, '--no-follow'], rpc)).rejects.toThrow(/did not answer/)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('omni workflow status', () => {
  it('reports the run, its placement, who asked and each seat session', async () => {
    const rpc = client()
    await run(['workflow', 'status', EXECUTION], rpc)
    expect(rpc).toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.runStatus, { executionId: EXECUTION })
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(STATUS)
  })

  it('says it in lines for a person', () => {
    expect(workflowStatusLines(STATUS)).toEqual([
      `Run ${EXECUTION}: running`,
      'Placed on mw0004 (dispatched-seats, named, 0.11 load per core at 2026-09-30T17:03:00.000Z)',
      'Folder on mw0004: /Users/cloud/.omni-fleet/workflow-runs/r1',
      `Requested by Sal: "${WORDS}"`,
      '  answers/seat-1 #1 accepted on mw0004 · codex gpt-5.6-sol · session 0199a1b2-0000-7000-8000-000000000001 · /Users/cloud/.omni-fleet/workflow-runs/r1/attempts/a1'
    ])
  })

  it('lists the findings verified so far after the seats', () => {
    const item = {
      key: 'find.r1.1',
      title: 'lost write',
      detail: 'How lost write breaks.',
      location: 'src/store.ts:12',
      severity: 'high' as const,
      stepId: 'verify',
      round: 1
    }
    const lines = workflowStatusLines({ ...STATUS, verified: { count: 1, items: [item] } })
    expect(lines.slice(-2)).toEqual(['Verified so far: 1', '  [high] lost write · src/store.ts:12'])
    expect(workflowStatusLines({ ...STATUS, verified: { count: 0, items: [] } }).at(-1)).toBe(
      'Verified so far: 0'
    )
  })
})

describe('the agent evidence a workflow Start carries', () => {
  it('goes with localWorkflow.run, localWorkflow.start and buildReview.start only', () => {
    const inherited = {
      compatibilityInvocationId: 'invocation-1',
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_agent' }
    }
    for (const method of ['localWorkflow.run', 'localWorkflow.start', 'buildReview.start']) {
      expect(runtimeCompatibilityEnvelope(method, inherited)).toMatchObject({
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_agent' }
      })
    }
    expect(runtimeCompatibilityEnvelope('localWorkflow.show', inherited)).toEqual({})
  })
})

describe('omni discover deliver', () => {
  it('requests publication for one existing run without starting another workflow', async () => {
    const rpc = client()
    rpc.mockResolvedValue({ result: { outcome: 'pending', reason: 'waiting for publication' } })
    await run(['discover', 'deliver', EXECUTION, '--json'], rpc)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.discoverDeliver, {
      executionId: EXECUTION
    })
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      outcome: 'pending',
      reason: 'waiting for publication'
    })
  })

  it('rejects a bad id before calling the runtime and reports a delivery failure', async () => {
    const rpc = client()
    rpc.mockResolvedValue({ result: { outcome: 'failed', reason: 'no verified account' } })
    await expect(run(['discover', 'deliver', '../other'], rpc)).rejects.toThrow('UUID')
    expect(rpc).not.toHaveBeenCalled()
    await run(['discover', 'deliver', EXECUTION], rpc)
    expect(process.exitCode).toBe(1)
  })
})
