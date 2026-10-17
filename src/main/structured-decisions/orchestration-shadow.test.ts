import { afterEach, describe, expect, it, vi } from 'vitest'
import { planReportChain } from '../../shared/__fixtures__/work-plan/plan-report-chain'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { snapshotDecisionRequest, type DecisionRequest } from '../../shared/structured-decisions'
import {
  installOrchestrationShadowObserver,
  observeOrchestrationOutcomeChange,
  observeOrchestrationToolAction
} from './orchestration-shadow'

const PRIVATE = 'PRIVATE_TRANSCRIPT_OR_CREDENTIAL_SENTINEL'

function verdictStep(
  id: string,
  kind: 'review' | 'judge' | 'verify',
  adversarial = false
): SessionChainAgentStep {
  return {
    id,
    agent: 'codex',
    prompt: PRIVATE,
    status: 'launched',
    verdict: { kind, over: ['candidate'], consumed: 'record' },
    ...(adversarial
      ? {
          review: {
            groupId: 'reviews',
            reviewerId: 'codex',
            round: 1,
            maxRounds: 1,
            candidateVersion: 'version',
            adversarial: true
          }
        }
      : {})
  }
}

function changedChain(): { before: SessionChain; after: SessionChain } {
  const before = planReportChain()
  before.verdicts = []
  before.outcomeSet!.outcomes[0]!.evidence = []
  const after = structuredClone(before)
  const steps = [
    verdictStep('new-judge', 'judge'),
    verdictStep('new-review', 'review'),
    verdictStep('new-adversarial', 'review', true),
    verdictStep('new-verify', 'verify')
  ]
  after.steps.push(...steps)
  after.verdicts = steps.map((step) => ({
    stepId: step.id,
    attemptId: `attempt-${step.id}`,
    consumptionKey: step.id,
    consumedAt: 1,
    verdict: {
      kind: step.verdict!.kind,
      status: 'pass',
      blockingFindings: [],
      notes: PRIVATE,
      candidateVersion: 'version'
    }
  }))
  after.outcomeSet!.attempts[0]!.dispatchId = 'dispatch'
  after.outcomeSet!.attempts[1]!.failure = { code: 'provider-authentication', at: 10 }
  after.outcomeSet!.attempts[1]!.error = PRIVATE
  after.outcomeSet!.outcomes[0]!.evidence = planReportChain().outcomeSet!.outcomes[0]!.evidence
  after.steps.push({
    kind: 'handoff',
    id: 'handoff',
    status: 'delivered',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: PRIVATE,
      sessionLabel: PRIVATE,
      recipients: [
        {
          employeeId: 'emp_person',
          name: PRIVATE,
          operationId: 'operation-id',
          delivery: 'sent',
          threadId: 'hth_receipt'
        }
      ],
      deliverables: { kind: 'files', paths: [PRIVATE] },
      includeSummary: true,
      note: PRIVATE,
      savedAt: 1,
      capturedAt: 2,
      summaryMarkdown: PRIVATE
    }
  })
  return { before, after }
}

function tool(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'pane',
    connectionId: null,
    source: 'claude',
    hookEventName: 'PreToolUse',
    launchToken: PRIVATE,
    payload: { state: 'working', prompt: PRIVATE, toolName: 'Bash', toolInput: PRIVATE },
    ...overrides
  }
}

afterEach(async () => {
  installOrchestrationShadowObserver(null)
  await Promise.resolve()
})

describe('orchestration shadow observation boundary', () => {
  it('observes all nine real lifecycle projections without passing authoritative answers or private content into inference', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const { before, after } = changedChain()
    const preserved = structuredClone(after)
    observeOrchestrationOutcomeChange(before, after)
    observeOrchestrationToolAction(tool())
    expect(observer).not.toHaveBeenCalled()
    await Promise.resolve()
    const requests = observer.mock.calls.map(([request]) => request as DecisionRequest)
    expect(new Set(requests.map((request) => request.capability))).toEqual(
      new Set([
        'orchestration.judge',
        'orchestration.review',
        'orchestration.adversarial_review',
        'orchestration.verify',
        'orchestration.routing',
        'orchestration.handoff',
        'orchestration.done_when',
        'orchestration.tool_action',
        'orchestration.error_classification'
      ])
    )
    for (const request of requests) {
      expect(() => snapshotDecisionRequest(request)).not.toThrow()
      expect(Object.isFrozen(request.state)).toBe(true)
      expect(JSON.stringify(request)).not.toContain(PRIVATE)
      expect(JSON.stringify(request)).not.toContain('/workspace/')
      expect(request.state).not.toHaveProperty('status')
      expect(request.state).not.toHaveProperty('verdict')
      expect(request.state).not.toHaveProperty('observed')
    }
    expect(
      observer.mock.calls.find(([request]) => request.capability === 'orchestration.judge')?.[1]
    ).toEqual(expect.objectContaining({ comparison: { classification: 'pass' } }))
    expect(after).toEqual(preserved)
  })

  it('isolates throwing and rejected observers, and gives them no mutable source objects', async () => {
    const { before, after } = changedChain()
    const preserved = structuredClone(after)
    let mutationRejected = false
    installOrchestrationShadowObserver((request) => {
      try {
        ;(request.state as Record<string, unknown>).changed = true
      } catch {
        mutationRejected = true
      }
      throw new Error('observer failure')
    })
    expect(() => observeOrchestrationOutcomeChange(before, after)).not.toThrow()
    await Promise.resolve()
    expect(mutationRejected).toBe(true)
    installOrchestrationShadowObserver(async () => {
      throw new Error('async observer failure')
    })
    observeOrchestrationOutcomeChange(before, after)
    await Promise.resolve()
    await Promise.resolve()
    expect(after).toEqual(preserved)
  })

  it('does not replay unchanged, skipped, missing-baseline, or provider replay observations', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const { before, after } = changedChain()
    observeOrchestrationOutcomeChange(after, after)
    observeOrchestrationOutcomeChange(undefined, after)
    const skipped = structuredClone(before)
    skipped.verdicts = [
      {
        stepId: 'plan-judge',
        attemptId: 'a',
        consumptionKey: 'skip',
        consumedAt: 1,
        skipped: true,
        verdict: { status: 'pass' }
      }
    ]
    observeOrchestrationOutcomeChange(before, skipped)
    observeOrchestrationToolAction(tool({ isReplay: true }))
    observeOrchestrationToolAction(tool({ restoredUnconfirmed: true }))
    observeOrchestrationToolAction(tool({ providerSessionOnly: true }))
    observeOrchestrationToolAction(tool({ hookEventName: 'Stop' }))
    await Promise.resolve()
    expect(observer).not.toHaveBeenCalled()
  })

  it('drops a disabled subscription and stale queued callbacks after replacement', async () => {
    const first = vi.fn(),
      second = vi.fn()
    const disposeFirst = installOrchestrationShadowObserver(first)
    observeOrchestrationToolAction(tool())
    const disposeSecond = installOrchestrationShadowObserver(second)
    disposeFirst()
    observeOrchestrationToolAction(tool())
    await Promise.resolve()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    disposeSecond()
    observeOrchestrationToolAction(tool())
    await Promise.resolve()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('bounds admission during a hook burst and discards custom tool names', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const event = tool({
      connectionId: 'remote',
      payload: { state: 'working', prompt: PRIVATE, toolName: PRIVATE, toolInput: PRIVATE }
    })
    for (let index = 0; index < 1_000; index++) {
      observeOrchestrationToolAction(event)
    }
    await Promise.resolve()
    expect(observer).toHaveBeenCalledTimes(64)
    expect(JSON.stringify(observer.mock.calls)).not.toContain(PRIVATE)
    expect(observer.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ comparison: { classification: 'unknown' } })
    )
    expect(observer.mock.calls[0]?.[0].state).toMatchObject({
      remoteExecution: true,
      knownTool: null
    })
  })
})
