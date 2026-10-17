import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import { resolveCouncilProgramRevision } from './council-program-revision'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from './workflow-execution-service'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import { constants, type DatabaseSync } from 'node:sqlite'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  task: { prompt: 'Question', evidence: 'Frozen evidence' },
  synthesizerId: 'claude',
  seats: [
    {
      id: 'claude',
      agent: 'claude',
      accountId: 'claude-account',
      model: 'claude-model',
      effort: 'low',
      lineage: 'anthropic',
      policyRevision: 'fixture-v1'
    },
    {
      id: 'codex',
      agent: 'codex',
      accountId: 'codex-account',
      model: 'gpt-model',
      effort: 'low',
      lineage: 'openai',
      policyRevision: 'fixture-v1'
    },
    {
      id: 'grok',
      agent: 'grok',
      accountId: 'grok-account',
      model: 'grok-model',
      effort: null,
      lineage: 'xai',
      policyRevision: 'fixture-v1'
    }
  ],
  discover: {
    dimensions: ['correctness', 'security', 'usability'],
    lenses: ['evidence', 'alternatives'],
    minimumSeverity: 'medium',
    maxCandidates: 12
  }
}
function native(input: Parameters<WorkflowAttemptLaunch>[0], override?: unknown) {
  const { call, attemptId } = input
  const labels = ['Response A', 'Response B', 'Response C'].filter(
    (_, index) => snapshot.seats[index].id !== call.seatId
  )
  const value =
    override ??
    (call.id.startsWith('peer/')
      ? {
          ranking: labels,
          assessments: labels.map((label) => ({
            label,
            strengths: 'Supported',
            weaknesses: 'Limited'
          }))
        }
      : call.id.startsWith('discover/')
        ? { findings: [], omittedCount: 0, omissionReason: '' }
        : {
            markdown: 'Supported answer',
            sources: [],
            ...(call.id.startsWith('answers/') ? { uncertainties: [] } : { disagreements: [] })
          })
  const agent = snapshot.seats.find((seat) => seat.id === call.seatId)!.agent
  const stdout =
    agent === 'codex'
      ? [
          { type: 'thread.started', thread_id: attemptId },
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
          { type: 'turn.completed', usage: {} }
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')
      : JSON.stringify(
          agent === 'claude'
            ? {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: attemptId,
                structured_output: value,
                modelUsage: { 'claude-model': {} },
                usage: {}
              }
            : {
                stopReason: 'end_turn',
                sessionId: attemptId,
                requestId: attemptId,
                structuredOutput: value,
                modelUsage: { 'grok-model': {} },
                usage: {}
              }
        )
  return {
    result: { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}
function setup(
  before?: (
    input: Parameters<WorkflowAttemptLaunch>[0],
    service: WorkflowExecutionService,
    id: string
  ) => void
) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const calls: string[] = []
  const progress = vi.fn()
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    progress,
    launch: (_snapshot, id) => async (input) => {
      calls.push(input.call.id)
      input.recordLaunch(input.attemptId)
      before?.(input, service, id)
      return native(input)
    }
  })
  const request = {
    conversationId: 'conversation',
    requestId: 'first',
    snapshot: { ...structuredClone(snapshot), councilProgramRevision: 4 as const },
    preset: 'council' as const,
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  }
  return { db, store, service, request, calls, progress }
}
function setSnapshotRevision(db: OrchestrationDb, id: string, revision?: number) {
  const row = db.db
    .prepare('SELECT snapshot_json FROM local_workflow_executions WHERE id=?')
    .get(id) as { snapshot_json: string }
  const envelope = JSON.parse(row.snapshot_json)
  if (revision === undefined) {
    delete envelope.snapshot.councilProgramRevision
  } else {
    envelope.snapshot.councilProgramRevision = revision
  }
  const json = JSON.stringify(envelope)
  db.db
    .prepare('UPDATE local_workflow_executions SET snapshot_json=?,snapshot_digest=? WHERE id=?')
    .run(json, workflowEvidenceDigest(json), id)
}
function unpinLegacySnapshot(db: OrchestrationDb, id: string) {
  setSnapshotRevision(db, id)
}
describe('host-owned bundled workflow execution', () => {
  it('keeps no-row non-host fixtures on the current program but rejects no-row legacy hosts', async () => {
    const f = setup()
    const id = f.store.create({ ...f.request, snapshot: structuredClone(snapshot) })
    expect(await resolveCouncilProgramRevision(f.store, id, 1, snapshot)).toBe(4)
    const hostId = f.store.create({
      ...f.request,
      conversationId: 'legacy-no-calls',
      requestId: 'legacy-no-calls',
      snapshot: { ...snapshot, host: { startedAt: 1 } }
    })
    await expect(
      resolveCouncilProgramRevision(
        f.store,
        hostId,
        1,
        f.store.inspect(hostId, 1).snapshot as WorkflowProgramSnapshot
      )
    ).rejects.toThrow('no call evidence')
    expect(f.calls).toHaveLength(0)
  })

  it('infers an unversioned non-host checkpoint from its persisted calls', async () => {
    const f = setup()
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 1 }
    })
    const completed = await f.service.wait(id)
    expect(completed.state).toBe('completed')
    unpinLegacySnapshot(f.db, id)
    const restored = new WorkflowExecutionService({
      store: f.store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => {
        throw new Error('Non-host completed replay must not launch')
      },
      progress: vi.fn()
    })
    expect(await restored.recoverCompleted(id, 1)).toEqual(completed)
    expect(f.calls).toHaveLength(7)
  })

  for (const revision of [1, 2, 3, 4] as const) {
    it(`replays completed unversioned Council prompt variant ${revision} without launching`, async () => {
      const f = setup()
      const id = f.service.start({
        ...f.request,
        snapshot: {
          ...f.request.snapshot,
          councilProgramRevision: revision,
          host: { startedAt: 1 }
        }
      })
      const completed = await f.service.wait(id)
      expect(completed.state).toBe('completed')
      expect(f.calls).toHaveLength(7)
      unpinLegacySnapshot(f.db, id)
      const restored = new WorkflowExecutionService({
        store: f.store,
        slots: new WorkflowScriptSlots(1),
        reservation: 1,
        launch: () => {
          throw new Error('Legacy completed replay must not launch')
        },
        progress: vi.fn()
      })
      expect(await restored.recoverCompleted(id, 1)).toEqual(completed)
      expect(f.calls).toHaveLength(7)
    })
  }

  it('resumes an original unversioned Council after its first accepted answer', async () => {
    let paused = false
    const f = setup((_input, service, id) => {
      if (!paused) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 1, host: { startedAt: 1 } }
    })
    expect((await f.service.wait(id)).state).toBe('paused')
    unpinLegacySnapshot(f.db, id)
    f.service.resume(id, 1)
    expect((await f.service.wait(id)).state).toBe('completed')
    expect(f.calls).toHaveLength(7)
    expect(f.calls.filter((call) => call === 'answers/claude')).toHaveLength(1)
  })

  it('resumes the second unversioned variant once peer order identifies it', async () => {
    let paused = false
    const f = setup((input, service, id) => {
      if (input.call.id === 'peer/codex' && !paused) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 2, host: { startedAt: 1 } }
    })
    expect((await f.service.wait(id)).state).toBe('paused')
    unpinLegacySnapshot(f.db, id)
    f.service.resume(id, 1)
    expect((await f.service.wait(id)).state).toBe('completed')
    expect(f.calls).toHaveLength(7)
    expect(f.calls.filter((call) => call === 'peer/codex')).toHaveLength(1)
  })

  for (const revision of [3, 4] as const) {
    it(`resumes variant ${revision} after the synthesis input identifies it`, async () => {
      let paused = false
      const f = setup((input, service, id) => {
        if (input.call.id === 'synthesis/final' && !paused) {
          paused = true
          service.control(id, 1, 'pause')
        }
      })
      const id = f.service.start({
        ...f.request,
        snapshot: {
          ...f.request.snapshot,
          councilProgramRevision: revision,
          host: { startedAt: 1 }
        }
      })
      expect((await f.service.wait(id)).state).toBe('paused')
      unpinLegacySnapshot(f.db, id)
      f.service.resume(id, 1)
      expect((await f.service.wait(id)).state).toBe('completed')
      expect(f.calls).toHaveLength(7)
    })
  }

  it('stops an ambiguous unversioned Council before another launch', async () => {
    let paused = false
    const f = setup((input, service, id) => {
      if (input.call.id === 'peer/codex' && !paused) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 3, host: { startedAt: 1 } }
    })
    expect((await f.service.wait(id)).state).toBe('paused')
    const count = f.calls.length
    unpinLegacySnapshot(f.db, id)
    f.service.resume(id, 1)
    expect(await f.service.wait(id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('ambiguous')
    })
    expect(f.calls).toHaveLength(count)
  })

  it('refuses an unsupported pinned Council revision before a native call', async () => {
    const f = setup()
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 99 as 4, host: { startedAt: 1 } }
    })
    expect(await f.service.wait(id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Unsupported Council program revision')
    })
    expect(f.calls).toHaveLength(0)
  })

  it('rejects a wrong pinned revision before launching any missing sibling', async () => {
    let paused = false
    const f = setup((_input, service, id) => {
      if (!paused) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 1, host: { startedAt: 1 } }
    })
    expect((await f.service.wait(id)).state).toBe('paused')
    setSnapshotRevision(f.db, id, 4)
    f.service.resume(id, 1)
    expect(await f.service.wait(id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Pinned Council revision conflicts')
    })
    expect(f.calls).toEqual(['answers/claude'])
  })

  for (const damage of [
    'input-digest',
    'result-json',
    'result-digest',
    'half-null',
    'quarantined'
  ]) {
    it(`rejects ${damage} call evidence before another native launch`, async () => {
      let paused = false
      const f = setup((_input, service, id) => {
        if (!paused) {
          paused = true
          service.control(id, 1, 'pause')
        }
      })
      const id = f.service.start({
        ...f.request,
        snapshot: { ...f.request.snapshot, councilProgramRevision: 4, host: { startedAt: 1 } }
      })
      expect((await f.service.wait(id)).state).toBe('paused')
      const column = {
        'input-digest': 'input_digest',
        'result-json': 'result_json',
        'result-digest': 'result_digest',
        'half-null': 'result_digest',
        quarantined: 'quarantined'
      }[damage]
      const value = damage === 'half-null' ? null : damage === 'quarantined' ? 1 : 'tampered'
      f.db.db
        .prepare(`UPDATE local_workflow_calls SET ${column}=? WHERE call_id='answers/claude'`)
        .run(value)
      f.service.resume(id, 1)
      expect((await f.service.wait(id)).state).toBe('failed')
      expect(f.calls).toEqual(['answers/claude'])
    })
  }

  it('blocks completed replay when historical call evidence matches no revision', async () => {
    const f = setup()
    const id = f.service.start({
      ...f.request,
      snapshot: { ...f.request.snapshot, councilProgramRevision: 1, host: { startedAt: 1 } }
    })
    expect((await f.service.wait(id)).state).toBe('completed')
    unpinLegacySnapshot(f.db, id)
    f.db.db
      .prepare("UPDATE local_workflow_calls SET input_digest=? WHERE call_id='answers/claude'")
      .run('unsupported-revision')
    const restored = new WorkflowExecutionService({
      store: f.store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => {
        throw new Error('Corrupt replay must not launch')
      },
      progress: vi.fn()
    })
    expect(await restored.recoverCompleted(id, 1)).toMatchObject({
      state: 'recovery_required',
      error: expect.stringContaining('Unsupported or corrupt')
    })
    expect(f.calls).toHaveLength(7)
  })

  it('caps native launches across two workflows with one shared host pool', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const slots = new WorkflowScriptSlots(2)
    const waiting: (() => void)[] = []
    let running = 0
    let peak = 0
    let launches = 0
    const service = new WorkflowExecutionService({
      store,
      slots,
      reservation: 1,
      progress: vi.fn(),
      launch: () => async (input) => {
        input.recordLaunch(input.attemptId)
        launches += 1
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => waiting.push(resolve))
        running -= 1
        return native(input)
      }
    })
    const request = {
      conversationId: 'first-conversation',
      requestId: 'first-request',
      snapshot: { ...structuredClone(snapshot), limits: { concurrency: 2 } },
      preset: 'council' as const,
      fence: 1,
      attemptLimit: 3,
      callLimit: 7,
      budgetLimit: 21
    }
    const first = service.start(request)
    const second = service.start({
      ...request,
      conversationId: 'second-conversation',
      requestId: 'second-request'
    })
    await vi.waitFor(() => expect(waiting).toHaveLength(2))
    expect({ running, peak, launches, slots: slots.running }).toEqual({
      running: 2,
      peak: 2,
      launches: 2,
      slots: 2
    })
    for (let index = 0; index < 14; index += 1) {
      const release = waiting.shift()
      if (!release) {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
      }
      const next = release ?? waiting.shift()
      next!()
    }
    expect((await service.wait(first)).state).toBe('completed')
    expect((await service.wait(second)).state).toBe('completed')
    expect(peak).toBe(2)
    expect(launches).toBe(14)
    expect(slots.running).toBe(0)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state=?')
        .get('accepted')
    ).toEqual({ count: 14 })
  })
  it('refuses a start when SQLite is read-only, then starts after storage recovers', async () => {
    const f = setup()
    f.db.db.pragma('query_only = ON')
    expect(() => f.service.start(f.request)).toThrow(/readonly|read-only/i)
    expect(f.calls).toHaveLength(0)
    expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()).toEqual({
      count: 0
    })
    f.db.db.pragma('query_only = OFF')
    const id = f.service.start(f.request)
    expect((await f.service.wait(id)).state).toBe('completed')
    expect(f.calls).toHaveLength(7)
  })
  it('does not launch when SQLite denies checkpoint reads', async () => {
    const f = setup()
    const nativeDb = (f.db.db as unknown as { db: DatabaseSync }).db
    nativeDb.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && table === 'local_workflow_executions'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK
    )
    expect(() => f.service.start(f.request)).toThrow(/prohibited/i)
    expect(f.calls).toHaveLength(0)
    nativeDb.setAuthorizer(null)
    expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()).toEqual({
      count: 0
    })
    const id = f.service.start(f.request)
    expect((await f.service.wait(id)).state).toBe('completed')
  })
  it('does not launch when SQLite reports full during durable admission', async () => {
    const f = setup()
    const pages = f.db.db.pragma('page_count', { simple: true }) as number
    f.db.db.pragma(`max_page_count = ${pages}`)
    const oversized = {
      ...f.request,
      snapshot: {
        ...structuredClone(snapshot),
        task: { ...snapshot.task, evidence: 'x'.repeat(4 * 1024 * 1024) }
      }
    }
    expect(() => f.service.start(oversized)).toThrow(/full/i)
    expect(f.calls).toHaveLength(0)
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toEqual({
      count: 0
    })
    expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()).toEqual({
      count: 0
    })
    f.db.db.pragma(`max_page_count = ${pages + 2_000}`)
    const id = f.service.start(f.request)
    expect((await f.service.wait(id)).state).toBe('completed')
  })
  it('runs all seven Council calls, persists completion and deduplicates Start', async () => {
    const f = setup()
    const id = f.service.start(f.request)
    expect(f.service.start(f.request)).toBe(id)
    const outcome = await f.service.wait(id)
    expect(outcome.state).toBe('completed')
    expect(outcome.result).toMatchObject({ synthesis: { markdown: 'Supported answer' } })
    expect(f.calls).toHaveLength(7)
    expect(f.store.inspect(id, 1).state).toBe('completed')
    expect(f.progress.mock.calls.map(([, event]) => event.phase)).toEqual([
      'Answers',
      'Peer review',
      'Synthesis'
    ])
    f.service.start(f.request)
    expect(f.calls).toHaveLength(7)
  })
  it('pauses admission, drains, and reuses the accepted answer on resume', async () => {
    let paused = false
    const f = setup((_input, service, id) => {
      if (!paused) {
        paused = true
        service.control(id, 1, 'pause')
      }
    })
    const id = f.service.start(f.request)
    expect(await f.service.wait(id)).toEqual({ state: 'paused' })
    expect(f.calls).toHaveLength(1)
    f.service.resume(id, 1)
    expect((await f.service.wait(id)).state).toBe('completed')
    expect(f.calls).toHaveLength(7)
    expect(f.calls.filter((call) => call === 'answers/claude')).toHaveLength(1)
  })
  it('stops without accepting a late result or admitting queued siblings', async () => {
    const f = setup((_input, service, id) => service.control(id, 1, 'stop'))
    const id = f.service.start(f.request)
    expect(await f.service.wait(id)).toEqual({ state: 'cancelled' })
    expect(f.calls).toHaveLength(1)
    expect(
      f.db.db
        .prepare(
          'SELECT COUNT(*) AS count FROM local_workflow_calls WHERE accepted_attempt_id IS NOT NULL'
        )
        .get()
    ).toMatchObject({ count: 0 })
  })
  it('completes Discover with zero findings using the same durable service', async () => {
    const f = setup()
    const id = f.service.start({ ...f.request, preset: 'discover', callLimit: 28 })
    const result = await f.service.wait(id)
    expect(result.state).toBe('completed')
    expect(result.result).toMatchObject({
      survivors: [],
      message: 'No findings in the inspected scope.'
    })
    expect(f.calls).toHaveLength(3)
  })
  it('repairs and replays the full 24-refutation Discover boundary without another launch', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const calls: string[] = []
    let refutationLaunches = 0
    let repairTarget: string | undefined
    const launch: WorkflowAttemptLaunch = async (input) => {
      calls.push(input.call.id)
      input.recordLaunch(input.attemptId)
      const { call } = input
      if (call.id.startsWith('refute/')) {
        refutationLaunches += 1
        if (refutationLaunches === 24) {
          repairTarget = call.id
        }
      }
      const value = call.id.startsWith('discover/')
        ? {
            findings: Array.from({ length: 4 }, (_, index) => ({
              issueKey: `issue-${call.id}-${index}`,
              title: `Issue ${index}`,
              location: `${call.id}/${index}.ts`,
              trigger: 'null input',
              impact: 'crash',
              severity: 'high',
              evidence: [{ ref: `${call.id}/${index}.ts`, description: 'unguarded access' }]
            })),
            omittedCount: 0,
            omissionReason: ''
          }
        : call.id.startsWith('refute/')
          ? {
              refuted: false,
              uncertain: refutationLaunches === 24,
              reason: 'Reproduced',
              evidence: []
            }
          : (() => {
              const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
                survivors: { id: string }[]
              }
              return {
                summary: 'Ranked all twelve verified findings',
                ranking: packet.survivors.map((finding) => ({
                  findingId: finding.id,
                  reason: 'Observed impact',
                  nextAction: 'Inspect evidence'
                }))
              }
            })()
      return native(input, value)
    }
    const service = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(3),
      reservation: 1,
      attemptsPerRun: 1,
      launch: () => launch,
      progress: vi.fn()
    })
    const request = {
      conversationId: 'discover-boundary',
      requestId: 'one',
      snapshot: {
        ...structuredClone(snapshot),
        discover: { ...snapshot.discover!, minimumSeverity: 'low' as const }
      },
      preset: 'discover' as const,
      fence: 1,
      attemptLimit: 3,
      callLimit: 28,
      budgetLimit: 84
    }
    const id = service.start(request)
    expect((await service.wait(id)).state).toBe('failed')
    expect(store.inspect(id, 1).state).toBe('failed')
    expect(repairTarget).toBeDefined()
    expect(calls).toHaveLength(27)
    expect(calls.filter((call) => call.startsWith('refute/'))).toHaveLength(24)
    expect(calls.some((call) => call === 'rank/final')).toBe(false)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state=?')
        .get('accepted')
    ).toEqual({ count: 26 })
    store.retryFailed(id, 1)
    service.resume(id, 1)
    const result = await service.wait(id)
    expect(result.state).toBe('completed')
    const survivors = (result.result as { survivors: { outcome: string }[] }).survivors
    expect(survivors).toHaveLength(12)
    expect(survivors.every((finding) => finding.outcome === 'survives')).toBe(true)
    expect(calls).toHaveLength(29)
    expect(calls.filter((call) => call.startsWith('refute/'))).toHaveLength(25)
    expect(calls.filter((call) => call === repairTarget)).toHaveLength(2)
    expect(calls.filter((call) => call === 'rank/final')).toHaveLength(1)
    expect(new Set(calls).size).toBe(28)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state=?')
        .get('accepted')
    ).toEqual({ count: 28 })
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state=?')
        .get('failed')
    ).toEqual({ count: 1 })
    const restored = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(3),
      reservation: 1,
      launch: () => launch,
      progress: vi.fn()
    })
    expect((await restored.recoverCompleted(id, 1)).result).toEqual(result.result)
    expect(calls).toHaveLength(29)
  })
  it('rejects a second request in an unfinished conversation', async () => {
    const f = setup()
    const id = f.service.start(f.request)
    expect(() => f.service.start({ ...f.request, requestId: 'second' })).toThrow(
      'unfinished workflow'
    )
    await f.service.wait(id)
  })
  it('retains an unresolved attempt when launch exit cannot be proved', async () => {
    const f = setup(() => {
      throw new Error('Exit receipt unavailable')
    })
    const id = f.service.start(f.request)
    expect((await f.service.wait(id)).state).toBe('recovery_required')
    expect(f.store.inspect(id, 1).state).toBe('stopping')
    expect(f.calls).toHaveLength(1)
    expect(() => f.store.finish(id, 1, true)).toThrow('exit reconciliation')
    expect(() => f.service.start({ ...f.request, requestId: 'replacement' })).toThrow(
      'unfinished workflow'
    )
  })
  it('does not replay a persisted Start under a new service without recovery', async () => {
    const f = setup()
    const id = f.service.start(f.request)
    await f.service.wait(id)
    const launch = vi.fn()
    const restored = new WorkflowExecutionService({
      store: f.store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch,
      progress: vi.fn()
    })
    expect(restored.start(f.request)).toBe(id)
    await expect(restored.wait(id)).rejects.toThrow('host recovery')
    expect(launch).not.toHaveBeenCalled()
    const replay = restored.recoverCompleted(id, 1)
    expect(restored.control(id, 1, 'stop')).toBe('completed')
    expect((await replay).result).toEqual((await f.service.wait(id)).result)
    expect(launch).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(7)
  })
  it.each(['missing', 'corrupt'])(
    'blocks completed recovery with %s evidence without a launch',
    async (fault) => {
      const f = setup()
      const id = f.service.start(f.request)
      await f.service.wait(id)
      if (fault === 'missing') {
        f.db.db.prepare("DELETE FROM local_workflow_calls WHERE call_id='synthesis/final'").run()
      } else {
        f.db.db
          .prepare(
            "UPDATE local_workflow_calls SET result_json='{}' WHERE call_id='synthesis/final'"
          )
          .run()
      }
      const launch = vi.fn()
      const restored = new WorkflowExecutionService({
        store: f.store,
        slots: new WorkflowScriptSlots(1),
        reservation: 1,
        launch,
        progress: vi.fn()
      })
      expect((await restored.recoverCompleted(id, 1)).state).toBe('recovery_required')
      expect(
        f.db.db.prepare('SELECT state FROM local_workflow_executions WHERE id=?').get(id)
      ).toMatchObject({ state: 'recovery_failed' })
      expect(launch).not.toHaveBeenCalled()
      expect(
        f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get()
      ).toMatchObject({ count: 7 })
    }
  )
})
