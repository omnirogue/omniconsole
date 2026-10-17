import { localWorkflowAttemptCost } from './local-workflow-attempt-cost'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectLocalWorkflow } from './local-workflow-projection'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'
import { WorkflowLiveRegistry } from './workflow-live-registry'
import { readWorkflowLaunchedAt } from './workflow-launch-receipt'

vi.mock('./workflow-process-receipt', () => ({ readWorkflowProcessReceipt: vi.fn() }))
vi.mock('./workflow-launch-receipt', () => ({ readWorkflowLaunchedAt: vi.fn() }))
// The Council package owns its run view; these tests cover only the generic call projection.
vi.mock('./local-workflow-council-projection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  councilStageDefinitions: () => [],
  projectCouncilRun: () => undefined,
  councilResultMarkdown: () => undefined
}))

const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.clearAllMocks()
})

const snapshot: LocalWorkflowHostSnapshot = {
  version: 1,
  councilProgramRevision: 6,
  access: 'workspace-read',
  task: { prompt: 'Which cache should we use?', evidence: '' },
  seats: (
    [
      ['seat-1', 'claude', 'claude-opus-5', 'anthropic'],
      ['seat-2', 'codex', 'gpt-5.6-sol', 'openai'],
      ['seat-3', 'gemini', 'gemini-3.8-flash', 'google']
    ] as const
  ).map(([id, agent, model, lineage]) => ({
    id,
    agent,
    model,
    lineage,
    accountId: 'account',
    effort: null,
    policyRevision: 'test'
  })),
  synthesizerId: 'seat-1',
  council: { memberIds: ['seat-1', 'seat-2', 'seat-3'] },
  discover: createLocalWorkflowDraft('council').discover,
  host: {
    workspaceId: 'workspace',
    conversationId: 'conversation',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 2,
    sources: [],
    coverage: []
  }
}

function fixture(frozen: LocalWorkflowHostSnapshot = snapshot) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const id = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: frozen,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  const call = (callId: string, result?: unknown) => {
    const json = result === undefined ? null : JSON.stringify(result)
    db.db
      .prepare(
        'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json, result_digest) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, callId, 'input', json, json === null ? null : workflowEvidenceDigest(json))
  }
  const attempt = (attemptId: string, callId: string, state: string, receipt: unknown) =>
    db.db
      .prepare(
        'INSERT INTO local_workflow_attempts (id,execution_id,call_id,ordinal,fence,state,reservation,receipt_json) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(attemptId, id, callId, 1, 1, state, 1, JSON.stringify(receipt))
  return { db, store, id, call, attempt }
}

describe('local workflow call projection', () => {
  it('projects seats, receipts, live overlays and live-only calls without reading logs', () => {
    const f = fixture()
    const terminal = { attemptId: 'x', processReceiptRef: 'x/launch.json', liveness: 'exited' }
    f.call('answer/seat-1', { markdown: 'Use an LRU cache.' })
    f.attempt('attempt-answer', 'answer/seat-1', 'accepted', {
      ...terminal,
      usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }
    })
    f.call('answer/seat-2')
    f.attempt('attempt-codex', 'answer/seat-2', 'running', { processReceiptRef: 'y' })
    f.call('rank/seat-2')
    f.attempt('attempt-rank', 'rank/seat-2', 'failed', {
      noLaunch: true,
      reason: 'Codex account is locked'
    })
    f.call('chair/final')
    f.attempt('attempt-chair', 'chair/final', 'failed', { ...terminal, error: 'schema mismatch' })
    vi.spyOn(f.store, 'readProcessIdentity').mockImplementation(
      (attemptId) => ({ attemptId }) as unknown as WorkflowProcessReceiptIdentity
    )
    vi.mocked(readWorkflowProcessReceipt).mockImplementation((identity) => ({
      result: { code: 0, signal: null, timedOut: false, stdout: 'raw', stderr: 'raw' },
      receipt: { attemptId: identity.attemptId, processReceiptRef: 'x', liveness: 'exited' },
      launchedAt: identity.attemptId === 'attempt-answer' ? 1_000 : 3_000,
      exitedAt: identity.attemptId === 'attempt-answer' ? 5_000 : 4_000
    }))
    const registry = new WorkflowLiveRegistry()
    const observer = registry.observer(f.id)
    registry.progress(f.id, { phase: 'Peer rankings', message: 'Two answers arrived' })
    registry.queued(f.id, 'answer/seat-2', 'seat-2')
    observer.starting('answer/seat-2', 'attempt-codex')
    observer.spawned('answer/seat-2', 'attempt-codex', 2_000)
    observer.update('answer/seat-2', 'attempt-codex', { text: 'Comparing caches' })
    registry.queued(f.id, 'answer/seat-3', 'seat-3')
    // The durable agent is retrying the chairman after its first attempt failed.
    registry.queued(f.id, 'chair/final', 'seat-1')
    const receipts = new Map()
    const project = () =>
      projectLocalWorkflow({
        db: f.db.db,
        store: f.store,
        executionId: f.id,
        active: true,
        live: registry.read(f.id),
        receipts
      })
    const view = project()
    const byId = new Map(view.calls.map((call) => [call.id, call]))
    expect(view).toMatchObject({
      revision: 6,
      phase: 'Peer rankings',
      log: ['Two answers arrived'],
      running: 1,
      queued: 2,
      usage: { tokens: { kind: 'reported', input: 150, output: 20 } }
    })
    expect(view.usage?.limitation).toBeUndefined()
    expect(byId.get('answer/seat-1')).toMatchObject({
      state: 'completed',
      seatId: 'seat-1',
      agent: 'claude',
      seatLabel: 'Claude',
      modelLabel: 'Claude Opus 5',
      tokens: { input: 150, output: 20 },
      startedAt: 1_000,
      endedAt: 5_000,
      resultMarkdown: 'Use an LRU cache.'
    })
    expect(byId.get('answer/seat-1')?.live).toBeUndefined()
    expect(byId.get('answer/seat-2')).toMatchObject({
      state: 'running',
      agent: 'codex',
      modelLabel: 'GPT-5.6 Sol',
      startedAt: 2_000,
      live: { phase: 'running', tail: 'Comparing caches', outputChars: 16, startedAt: 2_000 }
    })
    expect(byId.get('answer/seat-3')).toMatchObject({
      state: 'queued',
      attempt: 0,
      agent: 'gemini',
      modelLabel: 'Gemini 3.8 Flash',
      live: { phase: 'waiting' }
    })
    expect(byId.get('rank/seat-2')).toMatchObject({
      state: 'failed',
      error: 'Codex account is locked'
    })
    expect(byId.get('chair/final')).toMatchObject({
      state: 'queued',
      seatId: 'seat-1',
      error: 'schema mismatch',
      live: { phase: 'waiting' }
    })
    expect(byId.get('chair/final')?.endedAt).toBeUndefined()
    expect(view.calls.every((call) => !call.stdout && !call.stderr && !call.outputTruncated)).toBe(
      true
    )
    // Terminal receipts are verified once per attempt, not on every pushed view.
    project()
    expect(readWorkflowProcessReceipt).toHaveBeenCalledTimes(2)
  })

  it('times a running call from its launch receipt when no live signal has arrived', () => {
    const f = fixture()
    f.call('answer/seat-2')
    f.attempt('attempt-codex', 'answer/seat-2', 'running', { processReceiptRef: 'y' })
    f.call('answer/seat-1')
    f.attempt('attempt-claude', 'answer/seat-1', 'running', { processReceiptRef: 'z' })
    vi.spyOn(f.store, 'readProcessIdentity').mockImplementation(
      (attemptId) => ({ attemptId }) as unknown as WorkflowProcessReceiptIdentity
    )
    vi.mocked(readWorkflowLaunchedAt).mockImplementation((identity) =>
      identity.attemptId === 'attempt-codex' ? 7_000 : 8_000
    )
    // Claude's spawn signal never came (a launcher without live hooks, or a restart).
    const registry = new WorkflowLiveRegistry()
    registry.queued(f.id, 'answer/seat-1', 'seat-1')
    registry.acquired(f.id, 'answer/seat-1')
    const receipts = new Map()
    const project = () =>
      projectLocalWorkflow({
        db: f.db.db,
        store: f.store,
        executionId: f.id,
        active: true,
        live: registry.read(f.id),
        receipts
      })
    const byId = new Map(project().calls.map((call) => [call.id, call]))
    expect(byId.get('answer/seat-2')).toMatchObject({ state: 'running', startedAt: 7_000 })
    expect(byId.get('answer/seat-2')?.live).toBeUndefined()
    expect(byId.get('answer/seat-1')).toMatchObject({
      state: 'running',
      startedAt: 8_000,
      live: { phase: 'running' }
    })
    project()
    expect(readWorkflowLaunchedAt).toHaveBeenCalledTimes(2)
  })

  it('says what a waiting call waits for: a free slot or its provider account', () => {
    const f = fixture()
    const registry = new WorkflowLiveRegistry()
    const observer = registry.observer(f.id)
    registry.queued(f.id, 'answer/seat-1', 'seat-1')
    registry.queued(f.id, 'answer/seat-2', 'seat-2')
    // Codex's account home is held by another run: the call gave its slot back and waits.
    observer.waiting('answer/seat-2', 'account')
    registry.queued(f.id, 'answer/seat-3', 'seat-3')
    observer.starting('answer/seat-3', 'attempt-gemini')
    const view = projectLocalWorkflow({
      db: f.db.db,
      store: f.store,
      executionId: f.id,
      active: true,
      live: registry.read(f.id)
    })
    const byId = new Map(view.calls.map((call) => [call.id, call]))
    expect(byId.get('answer/seat-1')?.live).toMatchObject({ phase: 'waiting', reason: 'slot' })
    expect(byId.get('answer/seat-2')?.live).toMatchObject({ phase: 'waiting', reason: 'account' })
    // Once it starts, a call waits for nothing.
    expect(byId.get('answer/seat-3')?.live?.phase).toBe('starting')
    expect(byId.get('answer/seat-3')?.live?.reason).toBeUndefined()
  })

  it('numbers a repeated Council model on its calls and follow-up as the run view does', () => {
    const twin = { ...snapshot.seats[0], id: 'seat-4', effort: 'low' }
    const repeated: LocalWorkflowHostSnapshot = {
      ...snapshot,
      seats: [...snapshot.seats, twin],
      synthesizerId: 'seat-4',
      council: { memberIds: ['seat-1', 'seat-3', 'seat-4'] }
    }
    const project = (frozen: LocalWorkflowHostSnapshot) => {
      const f = fixture(frozen)
      for (const callId of ['answer/seat-1', 'answer/seat-4', 'rank/seat-4']) {
        f.call(callId)
      }
      f.call('chair/final', { markdown: 'Use an LRU cache.' })
      f.db.db.prepare("UPDATE local_workflow_executions SET state='completed' WHERE id=?").run(f.id)
      const registry = new WorkflowLiveRegistry()
      registry.queued(f.id, 'answer/seat-3', 'seat-3')
      const view = projectLocalWorkflow({
        db: f.db.db,
        store: f.store,
        executionId: f.id,
        active: false,
        live: registry.read(f.id)
      })
      return {
        followUpLabel: view.followUpLabel,
        labels: Object.fromEntries(view.calls.map((call) => [call.id, call.modelLabel]))
      }
    }
    expect(project(repeated)).toEqual({
      followUpLabel: 'Claude Opus 5 (2)',
      labels: {
        'answer/seat-1': 'Claude Opus 5 (1)',
        'answer/seat-4': 'Claude Opus 5 (2)',
        'rank/seat-4': 'Claude Opus 5 (2)',
        'chair/final': 'Claude Opus 5 (2)',
        'answer/seat-3': 'Gemini 3.8 Flash'
      }
    })
    // A chairman outside the council keeps the plain name, and so does a model it does not repeat.
    const outside = project({ ...repeated, council: { memberIds: ['seat-1', 'seat-3'] } })
    expect(outside.followUpLabel).toBe('Claude Opus 5')
    expect(outside.labels['answer/seat-1']).toBe('Claude Opus 5')
  })

  it('reports no token usage when no receipt carries any', () => {
    const f = fixture()
    f.call('answer/seat-1', { markdown: 'Answer' })
    f.attempt('attempt-answer', 'answer/seat-1', 'accepted', {
      attemptId: 'attempt-answer',
      processReceiptRef: 'x',
      liveness: 'exited',
      usage: {}
    })
    vi.mocked(readWorkflowProcessReceipt).mockImplementation(() => {
      throw new Error('Workflow process receipt is unverifiable')
    })
    const view = projectLocalWorkflow({
      db: f.db.db,
      store: f.store,
      executionId: f.id,
      active: false
    })
    expect(view.usage?.tokens).toBeNull()
    expect(view.calls[0]).toMatchObject({
      state: 'completed',
      error: expect.stringMatching(/unverifiable|missing or corrupt/)
    })
    expect(view.phase).toBeUndefined()
    expect(view.log).toBeUndefined()
  })

  it('prices an accepted call from the CLI bill, else list prices, else not at all', () => {
    const f = fixture()
    const terminal = { processReceiptRef: 'x', liveness: 'exited' }
    // A real T1 Claude call: its cache writes all used the 1-hour TTL.
    const claudeUsage = {
      input_tokens: 12,
      output_tokens: 5607,
      cache_read_input_tokens: 89311,
      cache_creation_input_tokens: 27768,
      cache_creation: { ephemeral_1h_input_tokens: 27768, ephemeral_5m_input_tokens: 0 }
    }
    const accepted = (callId: string, attemptId: string, receipt: Record<string, unknown>) => {
      f.call(callId, { markdown: 'Answer' })
      f.attempt(attemptId, callId, 'accepted', { attemptId, ...terminal, ...receipt })
    }
    accepted('answer/seat-1', 'billed', { usage: claudeUsage, resolvedModels: ['claude-opus-5'] })
    accepted('rank/seat-1', 'unbilled', { usage: claudeUsage, resolvedModels: ['claude-opus-5'] })
    accepted('answer/seat-2', 'codex', {
      usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 }
    })
    accepted('answer/seat-3', 'gemini', { usage: { stats: { input_tokens: 10 } } })
    accepted('chair/final', 'mixed', {
      usage: claudeUsage,
      resolvedModels: ['claude-opus-5', 'claude-haiku-4-5']
    })
    f.call('rank/seat-2')
    f.attempt('failed', 'rank/seat-2', 'failed', { attemptId: 'failed', ...terminal })
    vi.spyOn(f.store, 'readProcessIdentity').mockImplementation(
      (attemptId) => ({ attemptId }) as unknown as WorkflowProcessReceiptIdentity
    )
    const bill = '{"type":"result","subtype":"success","total_cost_usd":0.4625705}\n'
    vi.mocked(readWorkflowProcessReceipt).mockImplementation((identity) => ({
      result: {
        code: 0,
        signal: null,
        timedOut: false,
        stdout:
          identity.attemptId === 'billed' || identity.attemptId === 'failed'
            ? `{"type":"system","subtype":"init"}\nnot json\n${bill}`
            : '{"type":"turn.completed"}\n',
        stderr: ''
      },
      receipt: { attemptId: identity.attemptId, processReceiptRef: 'x', liveness: 'exited' },
      launchedAt: 1_000,
      exitedAt: 2_000
    }))
    const view = projectLocalWorkflow({
      db: f.db.db,
      store: f.store,
      executionId: f.id,
      active: false,
      receipts: new Map()
    })
    const cost = Object.fromEntries(view.calls.map((call) => [call.id, call.cost]))
    expect(cost['answer/seat-1']).toEqual({ usd: 0.4625705, source: 'cli' })
    // Opus 5 list prices with the 1-hour write rate reproduce the CLI's own bill for the call.
    expect(cost['rank/seat-1']?.source).toBe('table')
    expect(cost['rank/seat-1']?.usd).toBeCloseTo(0.4625705, 9)
    // Codex input includes its cached share: 600 x $5 + 400 x $0.50 + 100 x $30 per MTok.
    expect(cost['answer/seat-2']?.source).toBe('table')
    expect(cost['answer/seat-2']?.usd).toBeCloseTo(0.0062, 9)
    // No price table for Gemini or totals across two models; a failed attempt retains its bill.
    expect(cost['answer/seat-3']).toBeUndefined()
    expect(cost['chair/final']).toBeUndefined()
    expect(cost['rank/seat-2']).toEqual({ usd: 0.4625705, source: 'cli' })
  })

  it('prices a Codex call past 272K cumulative tokens at base rates, since the tier is per request', () => {
    const f = fixture()
    f.call('answer/seat-2', { markdown: 'Answer' })
    f.attempt('codex', 'answer/seat-2', 'accepted', {
      attemptId: 'codex',
      processReceiptRef: 'x',
      liveness: 'exited',
      usage: { input_tokens: 1_200_000, cached_input_tokens: 1_100_000, output_tokens: 20_000 }
    })
    vi.spyOn(f.store, 'readProcessIdentity').mockImplementation(
      (attemptId) => ({ attemptId }) as unknown as WorkflowProcessReceiptIdentity
    )
    vi.mocked(readWorkflowProcessReceipt).mockImplementation((identity) => ({
      result: { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' },
      receipt: { attemptId: identity.attemptId, processReceiptRef: 'x', liveness: 'exited' },
      launchedAt: 1_000,
      exitedAt: 2_000
    }))
    const view = projectLocalWorkflow({
      db: f.db.db,
      store: f.store,
      executionId: f.id,
      active: false,
      receipts: new Map()
    })
    const cost = view.calls.find((call) => call.id === 'answer/seat-2')?.cost
    // gpt-5.6-sol: 100K x $5 + 1.1M x $0.50 + 20K x $30 per MTok; tiering the sum gives $2.064.
    expect(cost?.source).toBe('table')
    expect(cost?.usd).toBeCloseTo(1.65, 9)
  })
})

it('sums billed failed, cancelled and accepted attempts once, retaining unknown-cost gaps', () => {
  const attempts = ['failed', 'cancelled', 'accepted', 'running'].map((state, ordinal) => ({
    id: String(ordinal),
    call_id: 'find/a0',
    ordinal,
    state,
    receipt_json: null
  }))
  const seat = { agent: 'claude' as const, model: 'claude-opus-5' }
  expect(localWorkflowAttemptCost(attempts, seat, (attempt) => Number(attempt.id) + 1)).toEqual({
    usd: 6,
    source: 'cli'
  })
  expect(
    localWorkflowAttemptCost(attempts, seat, (attempt) =>
      attempt.state === 'accepted' ? 3 : undefined
    )
  ).toEqual({ usd: 3, source: 'cli', partial: true })
})
