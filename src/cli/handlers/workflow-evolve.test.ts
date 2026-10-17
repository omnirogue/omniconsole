import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { RuntimeClientError } from '../runtime-client'
import { runtimeCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'
import { EVOLVE_RPC, type EvolveRunRecord } from '../../shared/evolve-workflow'
import { FIND_BEST_HANDLERS } from './find-best'
import { evolveRequestFromFlags, isEvolveRunFlags } from './workflow-evolve'
import { WORKFLOW_STATUS_HANDLERS } from './workflow-status'

const RUN_ID = 'evo_3f9a1c2e-0000-4000-8000-000000000000'
const LEDGER_ID = '1d738b22-999c-4661-8c16-fdc1763e1014'
const WORDS = 'agents can launch them for us if we request'

function record(patch: Partial<EvolveRunRecord> = {}): EvolveRunRecord {
  return {
    id: RUN_ID,
    createdAt: '2026-09-30T19:00:00.000Z',
    updatedAt: '2026-09-30T19:00:00.000Z',
    state: 'starting',
    request: { target: 'email-smoke', runsOn: 'fleet', runsOnHost: 'mw0001' },
    spec: 'jevlab/evolve/email/smoke.yaml',
    checkout: '~/Repos/jev-lab-evolve',
    submittedBy: 'Sal',
    placement: {
      runsOn: 'fleet',
      mode: 'dispatched-seats',
      choice: 'named',
      host: { name: 'mw0001', machine: 'm', cores: 24, loadPerCore: 0.18, readAt: 1, ssh: 'mw0001' }
    },
    host: 'mw0001',
    events: [],
    ...patch
  }
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

function run(argv: string[], rpc: ReturnType<typeof vi.fn>, json = true) {
  const parsed = parse(argv)
  const handlers = { ...FIND_BEST_HANDLERS, ...WORKFLOW_STATUS_HANDLERS }
  return handlers[parsed.commandPath.join(' ')]!({
    client: { call: rpc, isRemote: false },
    flags: parsed.flags,
    cwd: '/work',
    json
  } as unknown as HandlerContext)
}

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('omni workflow run evolve', () => {
  it('reads the preset from the positional name or --template and sends every field', () => {
    const flags = parse([
      'workflow',
      'run',
      'evolve',
      '--target',
      'email',
      '--iterations',
      '4',
      '--seed-from',
      'email-replies',
      '--usd-cap',
      '2.5',
      '--host',
      'mw0001',
      '--requested-by',
      'Sal',
      '--request',
      WORDS
    ]).flags
    expect(isEvolveRunFlags(flags)).toBe(true)
    expect(evolveRequestFromFlags(flags)).toMatchObject({
      target: 'email',
      iterations: 4,
      seedFrom: 'email-replies',
      usdCap: 2.5,
      runsOn: 'fleet',
      runsOnHost: 'mw0001',
      requestedBy: 'Sal',
      request: WORDS
    })
    expect(isEvolveRunFlags(parse(['workflow', 'run', '--template', 'evolve']).flags)).toBe(true)
    expect(
      evolveRequestFromFlags(parse(['workflow', 'run', 'evolve', '--spec-path', 'x/y.yaml']).flags)
    ).toMatchObject({ target: 'spec', specPath: 'x/y.yaml' })
  })

  it('names flag mistakes before anything starts', () => {
    const flags = (extra: string[]) => parse(['workflow', 'run', 'evolve', ...extra]).flags
    expect(() => evolveRequestFromFlags(flags(['--target', 'nope']))).toThrow(
      '--target: choose one of email-smoke, email, ads, or give --spec-path.'
    )
    expect(() => evolveRequestFromFlags(flags(['--spec-path', '../x.yaml']))).toThrow('--spec-path')
    expect(() => evolveRequestFromFlags(flags(['--iterations', 'lots']))).toThrow(
      '--iterations: lots is not a number.'
    )
    expect(() => evolveRequestFromFlags(flags(['--requested-by', 'Sal']))).toThrow(
      'Give --requested-by "<person>" and --request "<their words>" together.'
    )
  })

  it('carries the agent evidence on evolve.start, so the host holds an agent to the person', () => {
    const evidence = { orchestrationCompatibilityEvidence: { agentSessionId: 's' } } as never
    expect(runtimeCompatibilityEnvelope(EVOLVE_RPC.start, evidence)).toMatchObject(evidence)
  })

  it('returns with --no-follow once the ledger run id is known', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1_000 })
    const rpc = vi.fn(async (method: string) =>
      method === EVOLVE_RPC.start
        ? { result: { run: record() } }
        : { result: { run: record({ state: 'running', ledgerRunId: LEDGER_ID }) } }
    )
    await run(['workflow', 'run', 'evolve', '--host', 'mw0001', '--no-follow', '--json'], rpc)
    vi.useRealTimers()
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      started: true,
      template: 'evolve',
      runId: RUN_ID,
      ledgerRunId: LEDGER_ID,
      host: 'mw0001',
      statusCommand: `cd ~/Repos/jev-lab-evolve && .venv/bin/python -m jevlab evolve status ${LEDGER_ID} --json`
    })
  })

  it('reports a refused Start in the same document and exits 1', async () => {
    const reason =
      'Claude is not signed in on mw0003 (claude auth status reports no login over SSH).'
    const rpc = vi.fn(async () => {
      throw new RuntimeClientError('runtime_error', reason)
    })
    await run(['workflow', 'run', 'evolve', '--host', 'mw0003', '--json'], rpc)
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({
      started: false,
      template: 'evolve',
      reason
    })
    expect(process.exitCode).toBe(1)
  })

  it('reads an evo_ run with omni workflow status', async () => {
    const rpc = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe(EVOLVE_RPC.show)
      expect(params).toEqual({ id: RUN_ID })
      return { result: { run: record({ state: 'done', ledgerRunId: LEDGER_ID }) } }
    })
    await run(['workflow', 'status', RUN_ID], rpc, false)
    const text = String(log.mock.calls.at(-1)![0])
    expect(text).toContain(`Evolve run ${RUN_ID}: done`)
    expect(text).toContain(`Ledger run ${LEDGER_ID}`)
  })
})
