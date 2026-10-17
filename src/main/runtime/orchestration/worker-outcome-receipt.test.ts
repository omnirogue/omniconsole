import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { admitHubLinkedLaunch } from './hub-linked-launch-admission'
import {
  attachWorkerReceiptProviderObservation,
  readWorkerOutcomeReceipt
} from './worker-outcome-receipt'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from '../rpc/methods/orchestration-worker-control'
import {
  canonicalReceiptBinding,
  canonicalReceiptCurrentVerification,
  canonicalReceiptLifecycle,
  createCanonicalReceiptDispatch
} from './worker-outcome-verification-test-fixture'

const mocks = vi.hoisted(() => ({ hub: vi.fn(), lifecycle: vi.fn(), provider: vi.fn() }))
vi.mock('../../backoffice/console-workflow-client', () => ({
  consoleWorkflowClient: { getTask: mocks.hub, getTaskLifecycle: mocks.lifecycle }
}))
vi.mock('../rpc/methods/orchestration-worker-read', () => ({ handleWorkerRead: mocks.provider }))

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  mocks.hub.mockReset()
  mocks.lifecycle.mockReset()
  mocks.provider.mockReset()
})
afterEach(() => db.close())

function setup(hub = false) {
  const admitted = hub
    ? admitHubLinkedLaunch(db, {
        linkedItem: { hubTaskId: 'btk_content', title: 'Write content' },
        launchHubTaskId: 'btk_content',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'coord:pane'
      })!
    : null
  const run =
    admitted?.run ??
    db.createRun({
      objective: 'Write content',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'coord:pane'
    })
  const task = admitted?.task ?? db.createTask({ spec: 'Write content', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_worker', 'worker:pane', 'hash', 'process')
  return { run, task, dispatch }
}

function provider(dispatchId: string): OrchestrationWorkerReadResult {
  return {
    dispatchId,
    source: 'transcript',
    sourceIdentity: 'exact-source',
    provider: 'codex',
    transcript: { messages: [], nextCursor: 'cursor', limited: false, returnedMessageCount: 0 },
    cursor: 'cursor',
    status: { worker: 'ready', terminal: 'running', liveness: 'live' },
    fallbackReason: null,
    warnings: [],
    routeObservation: {
      source: 'provider-transcript',
      model: 'gpt-6.1-sol',
      effort: null,
      observedAt: 1790769600000
    }
  }
}

async function callReceipt(dispatch: string, observeProvider = false) {
  const method = ORCHESTRATION_WORKER_CONTROL_METHODS.find(
    (candidate) => candidate.name === 'orchestration.workerShow'
  )!
  return method.handler(method.params!.parse({ dispatch, receipt: true, observeProvider }), {
    runtime: { getOrchestrationDb: () => db }
  } as never)
}

describe('worker outcome receipt joins', () => {
  it('joins folder-capable personal records and distinguishes intervals from phase measurements', () => {
    const { run, task, dispatch } = setup()
    db.db
      .prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
      .run('2026-09-30 12:00:00', task.id)
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET dispatched_at = ?, completed_at = ?, status = ? WHERE id = ?'
      )
      .run('2026-09-30 12:00:02', '2026-09-30 12:00:10', 'completed', dispatch.id)
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    expect(receipt.binding).toMatchObject({
      runId: run.id,
      taskId: task.id,
      dispatchId: dispatch.id,
      hubTaskId: null
    })
    expect(receipt.recordIntervals).toEqual({
      taskCreatedToDispatchRecordedMs: 2000,
      dispatchRecordedToCompletionMs: 8000
    })
    expect(receipt.recordTimes.dispatchRecordedAt).toBe('2026-09-30T12:00:02Z')
    expect(Object.values(receipt.phaseDurations)).toEqual(Array(7).fill(null))
    expect(receipt.outcome).toMatchObject({
      reportedCompletedAt: '2026-09-30T12:00:10Z',
      independentlyAcceptedQuality: null
    })
    expect(receipt.route.actual).toBeNull()
    expect(receipt.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cost: null,
      currency: null
    })
  })

  it('never attributes a later task completion to an older failed attempt', () => {
    const { task, dispatch } = setup()
    db.db.prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?').run('failed', dispatch.id)
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', task.id)
    const newer = createRootDispatch(db, task.id, 'term_new')
    db.db
      .prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run('completed', '2026-09-30 13:00:00', task.id)
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    expect(receipt.status).toMatchObject({
      task: 'completed',
      dispatch: 'failed',
      currentDispatchId: newer.id,
      isCurrentDispatch: false
    })
    expect(receipt.outcome.reportedCompletedAt).toBeNull()
    expect(receipt.outcome.independentlyAcceptedQuality).toBeNull()
  })

  it('keeps invalid and reversed record times unknown', () => {
    const { dispatch } = setup()
    db.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, completed_at = ? WHERE id = ?')
      .run('2026-09-30 12:00:10', '2026-09-30 12:00:00', dispatch.id)
    expect(
      readWorkerOutcomeReceipt(db, dispatch.id).recordIntervals.dispatchRecordedToCompletionMs
    ).toBeNull()
    db.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run('invalid', dispatch.id)
    expect(readWorkerOutcomeReceipt(db, dispatch.id).recordTimes.dispatchRecordedAt).toBeNull()
  })

  it('refuses broken run/card joins and foreign provider output', () => {
    const { dispatch } = setup()
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    expect(() => attachWorkerReceiptProviderObservation(receipt, provider('ctx_foreign'))).toThrow(
      'binding differs'
    )
    db.db
      .prepare('UPDATE dispatch_contexts SET hub_task_id = ? WHERE id = ?')
      .run('btk_other', dispatch.id)
    expect(() => readWorkerOutcomeReceipt(db, dispatch.id)).toThrow('Run, Task and Dispatch differ')
  })

  it('keeps malformed remote provider observations unknown', () => {
    const { dispatch } = setup()
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    const output = provider(dispatch.id)
    if (output.source !== 'transcript') {
      throw new Error('Expected transcript fixture')
    }
    output.routeObservation!.observedAt = Number.POSITIVE_INFINITY
    attachWorkerReceiptProviderObservation(receipt, output)
    expect(receipt.route.actual).toBeNull()
    expect(receipt.providerRead.state).toBe('unavailable')
  })

  it('does not call the reconciling HUB board endpoint for linked work', async () => {
    const { dispatch } = setup(true)
    mocks.hub.mockResolvedValue({
      ok: true,
      data: {
        id: 'btk_content',
        title: 'Content',
        status: 'done',
        verified_at: '2026-09-30T12:00:00Z',
        result_ref: 'ses_other'
      }
    })
    const before = db.db.prepare('SELECT total_changes() AS changes').get()
    const response = await callReceipt(dispatch.id)
    expect(response).toMatchObject({
      receipt: {
        binding: { hubTaskId: 'btk_content' },
        hubEvidence: { state: 'unavailable', reason: 'canonical_attempt_binding_unavailable' },
        outcome: {
          independentlyAcceptedQuality: null,
          acceptanceReason: 'acceptance_not_observed'
        }
      }
    })
    expect(mocks.hub).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })

  it('separates requested launch arguments from an exact provider observation', () => {
    const { task } = setup()
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', task.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET status = ? WHERE task_id = ?')
      .run('completed', task.id)
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: 1,
      startOptions: {
        cwd: '/workspace/folder',
        launch: {
          requested: { agent: 'codex', model: 'requested', effort: 'ultra' },
          effective: { agent: 'codex', model: 'resolved', effort: 'medium' },
          effectiveSource: 'resolved-launch-arguments'
        }
      }
    })
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    expect(receipt.route).toMatchObject({
      requested: { model: 'requested' },
      resolved: { model: 'resolved' },
      actual: null,
      accountCategory: null
    })
    attachWorkerReceiptProviderObservation(receipt, provider(dispatch.id))
    expect(receipt.route.actual).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: null,
      sourceIdentity: 'exact-source'
    })
  })

  it('keeps malformed historical launch options unknown without losing the joined receipt', () => {
    const { task } = setup()
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', task.id)
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: 1,
      startOptions: {}
    })
    db.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run('{malformed', dispatch.id)
    expect(readWorkerOutcomeReceipt(db, dispatch.id)).toMatchObject({
      route: { requested: null, resolved: null, actual: null },
      recordWarnings: ['worker_start_options_unreadable']
    })
  })

  it('exposes the monotonic startup observation committed with ready and preserves it on receipt replay', () => {
    const run = db.createRun({
      objective: 'Start',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'coord:pane'
    })
    const task = db.createTask({ spec: 'Start', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: 1,
      startOptions: { cwd: '/workspace/folder' }
    })
    expect(readWorkerOutcomeReceipt(db, dispatch.id).phaseDurations.startupMs).toBeNull()
    const timing = {
      source: 'run-home-monotonic',
      from: 'dispatch-create',
      to: 'dispatch-input-accepted',
      durationMs: 124.5
    } as const
    db.markWorkerDispatchReady(dispatch.id, undefined, timing)
    const receipt = readWorkerOutcomeReceipt(db, dispatch.id)
    expect(receipt.startupTiming).toEqual(timing)
    expect(receipt.phaseDurations.startupMs).toBe(124.5)
    expect(readWorkerOutcomeReceipt(db, dispatch.id)).toEqual(receipt)
    expect(JSON.parse(db.getWorkerDispatch(dispatch.id)!.start_options)).toMatchObject({
      cwd: '/workspace/folder',
      startupTiming: timing
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'refuses invalid measured startup %s atomically',
    (durationMs) => {
      const run = db.createRun({
        objective: 'Start',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'coord:pane'
      })
      const task = db.createTask({ spec: 'Start', runId: run.id })
      const { dispatch } = db.createStartingWorkerDispatch({
        taskId: task.id,
        creator: { kind: 'system' },
        maxDepth: 1,
        startOptions: {}
      })
      expect(() =>
        db.markWorkerDispatchReady(dispatch.id, undefined, {
          source: 'run-home-monotonic',
          from: 'dispatch-create',
          to: 'dispatch-input-accepted',
          durationMs
        })
      ).toThrow('finite and nonnegative')
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('starting')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('pending')
      expect(readWorkerOutcomeReceipt(db, dispatch.id).startupTiming).toBeNull()
    }
  )

  it('replays receipt reads without writing or invoking provider/HUB for personal work', async () => {
    const { dispatch } = setup()
    const before = db.db.prepare('SELECT total_changes() AS changes').get()
    const first = await callReceipt(dispatch.id)
    expect(await callReceipt(dispatch.id)).toEqual(first)
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
    expect(mocks.hub).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it('performs only the opt-in bounded provider read for HUB-linked work', async () => {
    const { dispatch } = setup(true)
    mocks.provider.mockResolvedValue(provider(dispatch.id))
    const before = db.db.prepare('SELECT total_changes() AS changes').get()
    const response = await callReceipt(dispatch.id, true)
    expect(response).toMatchObject({
      receipt: {
        providerRead: { state: 'observed' },
        hubEvidence: { state: 'unavailable', reason: 'canonical_attempt_binding_unavailable' },
        outcome: { independentlyAcceptedQuality: null }
      }
    })
    expect(mocks.provider).toHaveBeenCalledOnce()
    expect(mocks.provider.mock.calls[0][0]).toEqual({
      dispatch: dispatch.id,
      source: 'transcript',
      limit: 1
    })
    expect(mocks.hub).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })

  it('retains unknown metrics after owner read failures without contacting HUB', async () => {
    const { dispatch } = setup(true)
    mocks.provider.mockRejectedValue(new Error('owner unreachable'))
    expect(await callReceipt(dispatch.id, true)).toMatchObject({
      receipt: {
        route: { actual: null },
        providerRead: { state: 'unavailable' },
        hubEvidence: { state: 'unavailable', reason: 'canonical_attempt_binding_unavailable' }
      }
    })
    expect(mocks.hub).not.toHaveBeenCalled()
    expect(mocks.provider).toHaveBeenCalledOnce()
  })

  it('reads exact lifecycle evidence once without the reconciling board call or database writes', async () => {
    const { dispatch } = createCanonicalReceiptDispatch(db)
    mocks.lifecycle.mockResolvedValue({
      ok: true,
      data: {
        ...canonicalReceiptLifecycle(),
        current_verification: canonicalReceiptCurrentVerification()
      }
    })
    const before = db.db.prepare('SELECT total_changes() AS changes').get()
    expect(await callReceipt(dispatch.id)).toMatchObject({
      receipt: {
        hubEvidence: { state: 'observed', canonicalReports: { scope: 'historical_attempt' } },
        outcome: {
          independentlyAcceptedQuality: null,
          currentAcceptance: { state: 'observed', reportId: 'ver_report1' }
        }
      }
    })
    expect(mocks.lifecycle).toHaveBeenCalledExactlyOnceWith({
      taskId: canonicalReceiptBinding.taskId
    })
    expect(mocks.hub).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })

  it('keeps older HUB lifecycle reads unavailable without retry or board fallback', async () => {
    const { dispatch } = createCanonicalReceiptDispatch(db)
    mocks.lifecycle.mockResolvedValue({ ok: false, error: { code: 'method_not_found' } })
    expect(await callReceipt(dispatch.id)).toMatchObject({
      receipt: { hubEvidence: { state: 'unavailable', reason: 'method_not_found' } }
    })
    expect(mocks.lifecycle).toHaveBeenCalledOnce()
    expect(mocks.hub).not.toHaveBeenCalled()
  })

  it('does not read HUB for a start receipt that differs from the signed Attempt intent', async () => {
    const { dispatch } = createCanonicalReceiptDispatch(db, {
      ...canonicalReceiptBinding,
      attemptId: 'att_foreign'
    })
    expect(await callReceipt(dispatch.id)).toMatchObject({
      receipt: {
        hubEvidence: { state: 'unavailable', reason: 'canonical_attempt_binding_unavailable' }
      }
    })
    expect(mocks.lifecycle).not.toHaveBeenCalled()
    expect(mocks.hub).not.toHaveBeenCalled()
  })

  it('rejects provider observations without the read-only receipt mode', () => {
    const method = ORCHESTRATION_WORKER_CONTROL_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )!
    expect(() => method.params!.parse({ dispatch: 'ctx_one', observeProvider: true })).toThrow(
      'Provider observation requires'
    )
  })
})
