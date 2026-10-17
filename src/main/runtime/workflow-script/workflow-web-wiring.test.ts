import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import type { WorkflowRoute } from '../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { OrchestrationDb } from '../orchestration/db'
import { graphHostRecords } from './graph/graph-jev-view'
import type { GraphCall, GraphConfig } from './graph/graph-plan-types'
import { runWorkflowGraphProgram } from './graph/graph-program'
import { createGraphWebSources, GraphWebChangedError } from './graph/graph-web-sources'
import { GraphJevStore } from './graph/graph-jev-store'
import { GraphWebStore } from './graph/graph-web-store'
import { GRAPH_WEB_SEAT_ID, WEB_RULES } from './graph/graph-web-types'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { createWorkflowProgramContext } from './workflow-program-context'
import { reconcileWorkflowProgram } from './workflow-program-recovery'
import { runWorkflowPreset } from './workflow-preset-runner'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'

// No spec asks for pages yet: the stand-in program asks for one web call through its config.
vi.mock('./graph/graph-program', () => ({
  runWorkflowGraphProgram: vi.fn(async (_context: unknown, config: GraphConfig) => {
    const outcome = config.readWeb ? await config.readWeb(WEB) : { failed: true }
    return { final: { stepId: 'final', markdown: JSON.stringify(outcome) }, gaps: [] }
  })
}))

const URL_ONE = 'https://a.example/one'
const WEB: GraphCall = {
  id: 'research/web',
  prompt: '',
  schema: {},
  output: 'text',
  seatId: GRAPH_WEB_SEAT_ID,
  dependencies: [],
  stepId: 'research',
  round: 1,
  agentIndex: 7,
  web: { rules: WEB_RULES, sources: [{ id: 'W1', url: URL_ONE }] },
  validateSemantics: () => null
}
const ROUTES: WorkflowRoute[] = ['claude', 'codex']
const council = workflowTemplate('council', ROUTES)
const spec = normalizeWorkflowSpec(
  {
    ...council,
    steps: council.steps.map((step) =>
      step.id === 'answer' ? { ...step, web: { urls: [URL_ONE] } } : step
    )
  },
  ROUTES
)

let dir = ''
const opened: OrchestrationDb[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-web-wiring-'))
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.mocked(runWorkflowGraphProgram).mockClear()
})
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  rmSync(dir, { recursive: true, force: true })
})

const snapshotOf = (host: object, graph = spec) => ({
  version: 1 as const,
  graphProgramRevision: GRAPH_PROGRAM_REVISION,
  graph: { spec: graph, agentSeats: {} },
  seats: [],
  synthesizerId: 'seat',
  task: { prompt: 'Read the pages', evidence: '' },
  host
})

const context = () =>
  createWorkflowProgramContext({
    agent: async () => null,
    guard: () => {},
    phase: () => {},
    log: () => {},
    isFatal: () => false
  })

const attempts = () => join(dir, 'local-workflow-attempts')

async function keepPage(executionId: string) {
  const read = vi.fn(async () => ({
    state: 'read' as const,
    text: 'Kept words.',
    title: 'Title',
    finalUrl: URL_ONE,
    redirects: [],
    contentType: 'text/plain',
    bytes: 11,
    rawSha256: '',
    textSha256: '',
    removedLines: 0,
    truncated: false,
    raw: Buffer.from('Kept words.'),
    fetchedAt: '2026-09-24T10:12:00.000Z'
  }))
  await createGraphWebSources({
    store: GraphJevStore.forExecution(executionId, undefined, 'web-sources.json'),
    calls: GraphJevStore.forExecution(executionId, undefined, 'web-calls.json'),
    blobs: GraphWebStore.forExecution(executionId),
    read
  })(WEB)
}

function pausedRun(host: object) {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: snapshotOf(host),
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 1,
    budgetLimit: 3
  })
  expect(store.requestControl(executionId, 1, 'pause')).toBe('paused')
  // The checkpoint's own mark that the web call began, as a live run writes it before fetching.
  const begin = () => store.attempts.webStarts(executionId, 1).begin(WEB.id, 'digest')
  const reconcile = () =>
    reconcileWorkflowProgram({
      store,
      slots: new WorkflowScriptSlots(2),
      executionId,
      fence: 1,
      attestNativeResult: () => {}
    })
  return { executionId, reconcile, begin, db }
}

describe('web wiring', () => {
  it('gives a live run a web reader only when it was admitted under web rules', async () => {
    const live = {
      jev: { executionId: 'run-1' },
      processes: {
        signal: new AbortController().signal,
        slot: <T>(work: () => Promise<T>) => work()
      }
    }
    await runWorkflowPreset(context(), 'council', snapshotOf({}, council), undefined, live)
    expect(vi.mocked(runWorkflowGraphProgram).mock.calls[0]![1].readWeb).toBeUndefined()
    vi.mocked(runWorkflowGraphProgram).mockClear()
    // A spec that reads pages but was admitted without web rules never runs at all.
    expect(() => runWorkflowPreset(context(), 'council', snapshotOf({}), undefined, live)).toThrow(
      'admitted without web rules'
    )
    expect(runWorkflowGraphProgram).not.toHaveBeenCalled()
    // Web rules on a spec that reads no page plan no web call: no reader is handed over.
    const rulesOnly = snapshotOf({ webRules: WEB_RULES }, council)
    await runWorkflowPreset(context(), 'council', rulesOnly, undefined, live)
    expect(vi.mocked(runWorkflowGraphProgram).mock.calls[0]![1].readWeb).toBeUndefined()
    vi.mocked(runWorkflowGraphProgram).mockClear()
    await keepPage('run-1')
    await runWorkflowPreset(
      context(),
      'council',
      snapshotOf({ webRules: WEB_RULES }),
      undefined,
      live
    )
    const admitted = vi.mocked(runWorkflowGraphProgram).mock.calls[0]![1]
    expect(await admitted.readWeb!(WEB)).toMatchObject({ value: { texts: { W1: 'Kept words.' } } })
  })

  it('replays a kept page in recovery, and never reads the network', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    await keepPage(run.executionId)
    const outcome = await run.reconcile()
    expect(outcome).toMatchObject({ state: 'paused' })
    expect(outcome.error).toBeUndefined()
    expect(String((outcome.result as { final: { markdown: string } }).final.markdown)).toContain(
      'Kept words.'
    )
  })

  it('holds a run whose kept page changed for manual recovery', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    await keepPage(run.executionId)
    const record = GraphJevStore.forExecution(run.executionId, undefined, 'web-sources.json')
    const { textSha256 } = (
      record.read(WEB.id)!.outcome as { value: { sources: { textSha256: string }[] } }
    ).value.sources[0]!
    const blob = join(attempts(), run.executionId, 'web', `${textSha256}.txt`)
    writeFileSync(blob, readFileSync(blob, 'utf8').replace('Kept', 'KepT'))
    expect(await run.reconcile()).toEqual({
      state: 'recovery_required',
      error: 'research/web: A stored web page changed or is missing (W1)'
    })
  })

  it('holds a run whose kept pages lost their record for manual recovery, never a new read', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    await keepPage(run.executionId)
    rmSync(join(attempts(), run.executionId, 'web-sources.json'))
    expect(await run.reconcile()).toEqual({
      state: 'recovery_required',
      error: 'research/web: A web call started but its record is missing (research/web)'
    })
  })

  it('holds a run for recovery when a reader ran but every web file is gone', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    // The checkpoint recorded a reader call, so its pages were kept even if power took the files.
    opened
      .at(-1)!
      .db.prepare(
        'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest) VALUES (?, ?, ?)'
      )
      .run(run.executionId, 'answer/claude', 'input')
    expect(await run.reconcile()).toEqual({
      state: 'recovery_required',
      error: 'research/web: A web call started but its record is missing (research/web)'
    })
  })

  it('holds a run for recovery when the checkpoint says the web call began and no file survived', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    expect(hasWorkflowRetryableCalls(run.db.db, run.executionId, 3)).toBe(true)
    run.begin()
    expect(await run.reconcile()).toEqual({
      state: 'recovery_required',
      error: 'research/web: A web call started but its record is missing (research/web)'
    })
    // Never Retry: a new read could hand its readers other pages than the ones they saw.
    expect(hasWorkflowRetryableCalls(run.db.db, run.executionId, 3)).toBe(false)
  })

  it('gives a live run the checkpoint\u2019s record of web calls that began', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    run.begin()
    // No web file exists: only the checkpoint knows the call began, and the reader refuses.
    const live = runWorkflowPreset(
      context(),
      'council',
      snapshotOf({ webRules: WEB_RULES }),
      undefined,
      {
        jev: { executionId: run.executionId },
        webStarts: new WorkflowCheckpointStore(run.db.db).attempts.webStarts(run.executionId, 1)
      }
    )
    await expect(live).rejects.toBeInstanceOf(GraphWebChangedError)
  })

  it('treats a web call with no record as a call still to make', async () => {
    const run = pausedRun({ webRules: WEB_RULES })
    expect(await run.reconcile()).toEqual({ state: 'paused' })
  })

  it('shows the web record in the run view only for a run admitted under web rules', async () => {
    await keepPage('run-1')
    expect(graphHostRecords('run-1', spec).web).toBeUndefined()
    expect(graphHostRecords('run-1', council, { webRules: WEB_RULES }).web).toBeUndefined()
    const web = graphHostRecords('run-1', spec, { webRules: WEB_RULES }).web!
    expect(Object.keys(web)).toEqual([WEB.id])
    expect(JSON.stringify(web)).not.toContain('Kept words.')
  })
})
