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
describe('Discover revision replay', () => {
  for (const revision of [undefined, 2, 3, 4, 5] as const) {
    for (const pauseAfterFirstRefutation of [false, true]) {
      it(`replays Discover revision ${revision ?? 1} after ${pauseAfterFirstRefutation ? 'partial pause' : 'completion'} without duplicate launches`, async () => {
        const db = new OrchestrationDb(':memory:')
        databases.push(db)
        const store = new WorkflowCheckpointStore(db.db)
        const calls: string[] = []
        let paused = false
        let service: WorkflowExecutionService
        const launch: WorkflowAttemptLaunch = async (input) => {
          calls.push(input.call.id)
          input.recordLaunch(input.attemptId)
          if (pauseAfterFirstRefutation && input.call.id.startsWith('refute/') && !paused) {
            paused = true
            service.control(executionId, 1, 'pause')
          }
          const value = input.call.id.startsWith('discover/')
            ? {
                findings:
                  input.call.id === 'discover/usability'
                    ? []
                    : [
                        {
                          issueKey:
                            revision === 4 && input.call.id === 'discover/security'
                              ? 'cross-tenant-cache-collision'
                              : 'tenant-cache-key-missing-tenant',
                          title: 'Tenant cache collision',
                          location: 'src/cache.ts:1-8',
                          trigger:
                            input.call.id === 'discover/correctness'
                              ? 'Tenant B requests shared report'
                              : 'B receives tenant A cache hit',
                          impact: 'Cross-tenant response',
                          severity: 'high',
                          evidence: [{ ref: 'src/cache.ts', description: 'Key omits tenant' }]
                        }
                      ],
                omittedCount: 0,
                omissionReason: ''
              }
            : input.call.id.startsWith('cluster/')
              ? (() => {
                  const packet = JSON.parse(
                    input.call.prompt.slice(input.call.prompt.indexOf('\n') + 1)
                  ) as { candidates: { id: string }[] }
                  return {
                    groups: [
                      {
                        ids: packet.candidates.map((candidate) => candidate.id),
                        reason: 'Same tenant cache root'
                      }
                    ]
                  }
                })()
              : input.call.id.startsWith('refute/')
                ? {
                    refuted: false,
                    uncertain: false,
                    reason: 'Contract establishes path',
                    evidence: []
                  }
                : (() => {
                    const packet = JSON.parse(
                      input.call.prompt.slice(input.call.prompt.indexOf('\n') + 1)
                    ) as {
                      survivors: { id: string }[]
                    }
                    return {
                      summary: 'Confirmed',
                      ranking: packet.survivors.map((finding) => ({
                        findingId: finding.id,
                        reason: 'Supported',
                        nextAction: 'Repair key'
                      }))
                    }
                  })()
          return native(input, value)
        }
        service = new WorkflowExecutionService({
          store,
          slots: new WorkflowScriptSlots(1),
          reservation: 1,
          launch: () => launch,
          progress: vi.fn()
        })
        const executionId = service.start({
          conversationId: `discover-${revision ?? 1}-${pauseAfterFirstRefutation}`,
          requestId: 'one',
          snapshot: {
            ...structuredClone(snapshot),
            ...(revision ? { discoverProgramRevision: revision } : {})
          },
          preset: 'discover',
          fence: 1,
          attemptLimit: 3,
          callLimit: revision === 4 || revision === 5 ? 30 : 28,
          budgetLimit: revision === 4 || revision === 5 ? 90 : 84
        })
        if (pauseAfterFirstRefutation) {
          expect((await service.wait(executionId)).state).toBe('paused')
          service.resume(executionId, 1)
        }
        const result = await service.wait(executionId)
        expect(result.state).toBe('completed')
        expect(
          (result.result as { selection: { selected: unknown[] } }).selection.selected
        ).toHaveLength(revision ? 1 : 2)
        expect(calls).toHaveLength(revision === 2 || revision === 3 ? 6 : 8)
        expect(new Set(calls).size).toBe(calls.length)
        const restored = new WorkflowExecutionService({
          store,
          slots: new WorkflowScriptSlots(1),
          reservation: 1,
          launch: () => {
            throw new Error('Replay must not launch')
          },
          progress: vi.fn()
        })
        expect(await restored.recoverCompleted(executionId, 1)).toEqual(result)
        expect(calls).toHaveLength(revision === 2 || revision === 3 ? 6 : 8)
      })
    }
  }
})
