import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from './workflow-execution-service'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  discoverProgramRevision: 7,
  task: { prompt: 'Find real bugs in checkout', evidence: '--- src/pay.ts ---\n1 | charge()' },
  synthesizerId: 'claude',
  seats: [
    ['claude', 'claude-model', 'anthropic'],
    ['codex', 'gpt-model', 'openai'],
    ['grok', 'grok-model', 'xai']
  ].map(([agent, model, lineage]) => ({
    id: agent,
    agent,
    accountId: `${agent}-account`,
    model,
    effort: agent === 'grok' ? null : 'low',
    lineage,
    policyRevision: 'fixture-v1'
  })) as WorkflowProgramSnapshot['seats'],
  discover: {
    dimensions: ['correctness', 'security', 'usability'],
    lenses: ['evidence', 'alternatives'],
    minimumSeverity: 'medium',
    maxCandidates: 12,
    finderIds: ['codex', 'grok'],
    lensIds: ['correctness'],
    depth: 'quick',
    focus: [],
    maxAgents: 20
  }
}

/** `sameFile`: the refund finder reports its defect at the caller in src/pay.ts. */
function value(call: Parameters<WorkflowAttemptLaunch>[0]['call'], sameFile = false): unknown {
  if (call.id === 'scout/map') {
    return {
      areas: [
        { name: 'Charge', files: ['src/pay.ts'], why: 'Moves money' },
        { name: 'Refund', files: ['src/refund.ts'], why: 'Returns money' }
      ]
    }
  }
  if (call.id === 'find/r1/repeats') {
    return {
      groups: [
        {
          findingIds: ['r1-a1-correctness-0', 'r1-a0-correctness-0'],
          rootCause: 'charge() runs without an idempotency key'
        }
      ]
    }
  }
  if (call.id.startsWith('find/')) {
    const own = call.id.includes('/0/') ? 'src/pay.ts' : 'src/refund.ts'
    const file = sameFile ? 'src/pay.ts' : own
    const refund = sameFile && own === 'src/refund.ts'
    return {
      findings: [
        {
          title: refund ? 'Refund retries charge the card again' : `Double submit in ${file}`,
          file,
          line: refund ? 40 : 1,
          endLine: null,
          severity: 'high',
          trigger: 'Two clicks',
          scenario: 'Charged twice',
          evidence: 'No idempotency key',
          fix: 'Add a key'
        }
      ],
      omitted: 0,
      filesRead: [own]
    }
  }
  if (call.id.startsWith('verify/')) {
    return {
      verdict: 'real',
      reason: 'Traced the handler',
      evidence: `${call.id}:1`,
      filesRead: ['src/pay.ts']
    }
  }
  const confirmed = [...new Set(call.dependencies.map((id) => id.split('/')[1]))]
  return {
    summary: 'Fix both double submits.',
    items: confirmed.map((id, index) => ({
      rank: index + 1,
      title: id,
      location: 'src/pay.ts:1',
      severity: 'high',
      scenario: 'Charged twice',
      fix: 'Add a key',
      findingIds: [id],
      parallelSafe: true
    })),
    refutedIds: [],
    unverifiedIds: []
  }
}

function native(input: Parameters<WorkflowAttemptLaunch>[0], sameFile = false) {
  const { call, attemptId } = input
  const result = value(call, sameFile)
  const agent = snapshot.seats.find((seat) => seat.id === call.seatId)!.agent
  const stdout =
    agent === 'codex'
      ? [
          { type: 'thread.started', thread_id: attemptId },
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } },
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
                structured_output: result,
                modelUsage: { 'claude-model': {} },
                usage: {}
              }
            : {
                stopReason: 'end_turn',
                sessionId: attemptId,
                requestId: attemptId,
                structuredOutput: result,
                modelUsage: { 'grok-model': {} },
                usage: {}
              }
        )
  return {
    result: { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

/** A process that exited without a usable answer, as a timed-out finder would. */
function failure(input: Parameters<WorkflowAttemptLaunch>[0]) {
  return {
    result: { code: 1, signal: null, timedOut: false, stdout: '', stderr: 'timed out' },
    receipt: {
      attemptId: input.attemptId,
      processReceiptRef: input.attemptId,
      liveness: 'exited' as const
    }
  }
}

function lastingService(store: WorkflowCheckpointStore, launched: string[], failRank: boolean) {
  let rankFailures = failRank ? 1 : 0
  return new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    attemptsPerRun: 1,
    launch: () => async (input) => {
      launched.push(input.call.id)
      input.recordLaunch(input.attemptId)
      if (input.call.id === 'rank/final' && rankFailures > 0) {
        rankFailures -= 1
        return failure(input)
      }
      return input.call.id === 'find/r1/1/correctness' ? failure(input) : native(input)
    },
    progress: vi.fn()
  })
}

function startLasting(service: WorkflowExecutionService, conversationId: string): string {
  return service.start({
    conversationId,
    requestId: 'one',
    snapshot: structuredClone(snapshot),
    preset: 'discover',
    fence: 1,
    attemptLimit: 3,
    callLimit: 20,
    budgetLimit: 60
  })
}

describe('Discover revision 7 lasting failures', () => {
  type Result = {
    findings: { id: string; title: string; status: string }[]
    report: { items: { findingIds: string[] }[] }
  }

  it('completes around a finder that failed every attempt and replays the same null', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const launched: string[] = []
    const service = lastingService(store, launched, false)
    const executionId = startLasting(service, 'lasting-finder')
    const outcome = await service.wait(executionId)
    expect(outcome.state).toBe('completed')
    // One attempt per invocation; the program invokes again until the three attempts are spent.
    expect(launched.filter((id) => id === 'find/r1/1/correctness')).toHaveLength(3)
    expect(launched).toHaveLength(9)
    const result = outcome.result as Result
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Double submit in src/pay.ts', status: 'confirmed' }
    ])
    expect(result.report.items.flatMap((item) => item.findingIds)).toEqual(['r1-a0-correctness-0'])
    const restored = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => {
        throw new Error('Replay must not launch')
      },
      progress: vi.fn()
    })
    expect(await restored.recoverCompleted(executionId, 1)).toEqual(outcome)
    expect(launched).toHaveLength(9)
  })

  it('retries only the failed rank while the exhausted finder stays a lasting null', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const launched: string[] = []
    const service = lastingService(store, launched, true)
    const executionId = startLasting(service, 'lasting-rank')
    expect((await service.wait(executionId)).state).toBe('failed')
    expect(launched.filter((id) => id === 'rank/final')).toHaveLength(1)
    store.retryFailed(executionId, 1)
    service.resume(executionId, 1)
    const outcome = await service.wait(executionId)
    expect(outcome.state).toBe('completed')
    expect(launched.filter((id) => id === 'rank/final')).toHaveLength(2)
    expect(launched.filter((id) => id === 'find/r1/1/correctness')).toHaveLength(3)
    expect(launched).toHaveLength(10)
    expect((outcome.result as Result).findings.map((finding) => finding.id)).toEqual([
      'r1-a0-correctness-0'
    ])
  })
})

describe('Discover revision 7 replay', () => {
  for (const pauseAtFirstVote of [false, true]) {
    it(`replays after ${pauseAtFirstVote ? 'a pause during verification' : 'completion'} without launching anything twice`, async () => {
      const db = new OrchestrationDb(':memory:')
      databases.push(db)
      const store = new WorkflowCheckpointStore(db.db)
      const launched: string[] = []
      let paused = false
      let executionId = ''
      const service: WorkflowExecutionService = new WorkflowExecutionService({
        store,
        slots: new WorkflowScriptSlots(1),
        reservation: 1,
        launch: () => async (input) => {
          launched.push(input.call.id)
          input.recordLaunch(input.attemptId)
          if (pauseAtFirstVote && input.call.id.startsWith('verify/') && !paused) {
            paused = true
            service.control(executionId, 1, 'pause')
          }
          return native(input)
        },
        progress: vi.fn()
      })
      executionId = service.start({
        conversationId: `discover-six-${pauseAtFirstVote}`,
        requestId: 'one',
        snapshot: structuredClone(snapshot),
        preset: 'discover',
        fence: 1,
        attemptLimit: 3,
        callLimit: 20,
        budgetLimit: 60
      })
      if (pauseAtFirstVote) {
        expect((await service.wait(executionId)).state).toBe('paused')
        expect(launched.filter((id) => id.startsWith('verify/'))).toHaveLength(1)
        service.resume(executionId, 1)
      }
      const outcome = await service.wait(executionId)
      expect(outcome.state).toBe('completed')
      expect(launched).toHaveLength(10)
      expect(new Set(launched).size).toBe(launched.length)
      expect(launched.filter((id) => id.startsWith('find/'))).toEqual([
        'find/r1/0/correctness',
        'find/r1/1/correctness'
      ])
      const result = outcome.result as {
        findings: { id: string; status: string }[]
        report: { items: { findingIds: string[] }[] }
      }
      expect(result.findings).toEqual([
        { id: 'r1-a0-correctness-0', title: 'Double submit in src/pay.ts', status: 'confirmed' },
        {
          id: 'r1-a1-correctness-0',
          title: 'Double submit in src/refund.ts',
          status: 'confirmed'
        }
      ])
      expect(result.report.items.flatMap((item) => item.findingIds)).toEqual([
        'r1-a0-correctness-0',
        'r1-a1-correctness-0'
      ])
      const restored = new WorkflowExecutionService({
        store,
        slots: new WorkflowScriptSlots(1),
        reservation: 1,
        launch: () => {
          throw new Error('Replay must not launch')
        },
        progress: vi.fn()
      })
      expect(await restored.recoverCompleted(executionId, 1)).toEqual(outcome)
      expect(launched).toHaveLength(10)
    })
  }
})

describe('Discover revision 7 repeat check replay', () => {
  it('journals the repeat check like any call and replays its merge without launching', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const launched: string[] = []
    const service = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => async (input) => {
        launched.push(input.call.id)
        input.recordLaunch(input.attemptId)
        return native(input, true)
      },
      progress: vi.fn()
    })
    const executionId = startLasting(service, 'repeat-check')
    const outcome = await service.wait(executionId)
    expect(outcome.state).toBe('completed')
    // Both finders reported one defect in src/pay.ts: one check, and three votes, not six.
    expect(launched.slice(0, 4)).toEqual([
      'scout/map',
      'find/r1/0/correctness',
      'find/r1/1/correctness',
      'find/r1/repeats'
    ])
    expect(launched.slice(4, 7).toSorted()).toEqual([
      'verify/r1-a0-correctness-0/correctness',
      'verify/r1-a0-correctness-0/reachability',
      'verify/r1-a0-correctness-0/reproduction'
    ])
    expect(launched.slice(7)).toEqual(['rank/final'])
    expect((outcome.result as { findings: unknown[] }).findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Double submit in src/pay.ts', status: 'confirmed' },
      {
        id: 'r1-a1-correctness-0',
        title: 'Refund retries charge the card again',
        status: 'confirmed',
        duplicateOf: 'r1-a0-correctness-0'
      }
    ])
    const restored = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      launch: () => {
        throw new Error('Replay must not launch')
      },
      progress: vi.fn()
    })
    expect(await restored.recoverCompleted(executionId, 1)).toEqual(outcome)
    expect(launched).toHaveLength(8)
  })
})
