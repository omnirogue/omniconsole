import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  planReportChain,
  planReportOutcome
} from '../../shared/__fixtures__/work-plan/plan-report-chain'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainHandoffStep
} from '../../shared/session-chain-types'
import type { SessionReviewGroupState } from '../../shared/session-chain-review'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { DecisionRequest } from '../../shared/structured-decisions'
import {
  installOrchestrationShadowObserver,
  observeOrchestrationOutcomeChange,
  observeOrchestrationToolAction
} from './orchestration-shadow'
import { ORCHESTRATION_SHADOW_LIMITS } from './orchestration-shadow-bounds'

const HISTORY_LENGTH = 100_000
const audit = () => ({ indexedReads: 0, ancientReads: 0, serializations: 0, mutations: 0 })
type Audit = ReturnType<typeof audit>

function history<T>(recent: T[], reads: Audit): T[] {
  const source = [...recent]
  const start = HISTORY_LENGTH - recent.length
  return new Proxy(source, {
    get(target, key, receiver) {
      if (key === 'length') {
        return HISTORY_LENGTH
      }
      if (key === 'toJSON') {
        reads.serializations++
        throw new Error('Raw history serialization')
      }
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads.indexedReads++
        if (Number(key) < start) {
          reads.ancientReads++
          throw new Error('Ancient history was inspected')
        }
        return target[Number(key) - start]
      }
      return Reflect.get(target, key, receiver)
    },
    has(target, key) {
      return typeof key === 'string' && /^\d+$/.test(key)
        ? Number(key) < HISTORY_LENGTH
        : Reflect.has(target, key)
    },
    set() {
      reads.mutations++
      throw new Error('Source history was changed')
    },
    deleteProperty() {
      reads.mutations++
      throw new Error('Source history was changed')
    }
  })
}

function recent<T>(make: (index: number) => T): T[] {
  return Array.from({ length: ORCHESTRATION_SHADOW_LIMITS.entries }, (_, index) => make(index))
}

function emptyChain(): SessionChain {
  const chain = planReportChain()
  chain.steps = []
  chain.verdicts = []
  chain.outcomeSet!.outcomes = []
  chain.outcomeSet!.attempts = []
  return chain
}

function judge(id: string): SessionChainAgentStep {
  return {
    id,
    agent: 'codex',
    prompt: 'Private prompt',
    status: 'launched',
    verdict: { kind: 'judge', over: ['candidate'], consumed: 'record' }
  }
}

function expectBounded(reads: Audit): void {
  expect(reads.indexedReads).toBeGreaterThan(0)
  expect(reads.indexedReads).toBeLessThanOrEqual(ORCHESTRATION_SHADOW_LIMITS.totalEntries)
  expect(reads).toMatchObject({ ancientReads: 0, serializations: 0, mutations: 0 })
}

function requests(observer: ReturnType<typeof vi.fn>): DecisionRequest[] {
  return observer.mock.calls.map(([request]) => request as DecisionRequest)
}

afterEach(async () => {
  installOrchestrationShadowObserver(null)
  await Promise.resolve()
})

describe('orchestration shadow source bounds', () => {
  it('samples recent retained histories and leaves truncated active-attempt totals unknown', async () => {
    const reads = audit()
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = emptyChain()
    const after = emptyChain()
    const attempts = recent((index) => ({
      ...planReportChain().outcomeSet!.attempts[0]!,
      id: `attempt-${index}`,
      outcomeId: `outcome-${index}`
    }))
    const outcomes = recent((index) => ({
      ...planReportOutcome(),
      id: `outcome-${index}`,
      conditions: [],
      evidence: []
    }))
    const changedAttempts = structuredClone(attempts)
    changedAttempts[31]!.dispatchId = 'new-dispatch'
    const changedOutcomes = structuredClone(outcomes)
    changedOutcomes[31]!.revision++
    const preservedAttempts = structuredClone(changedAttempts)
    const preservedOutcomes = structuredClone(changedOutcomes)
    const steps = recent((index) => judge(`step-${index}`))
    const receipts = recent((index) => ({
      stepId: `step-${index}`,
      attemptId: `attempt-${index}`,
      consumptionKey: `consumed-${index}`,
      consumedAt: index,
      verdict: { status: 'pass' }
    }))
    before.steps = history(steps, reads)
    after.steps = history(steps, reads)
    before.verdicts = history(receipts, reads)
    after.verdicts = history(receipts, reads)
    before.outcomeSet!.attempts = history(attempts, reads)
    after.outcomeSet!.attempts = history(changedAttempts, reads)
    before.outcomeSet!.outcomes = history(outcomes, reads)
    after.outcomeSet!.outcomes = history(changedOutcomes, reads)
    observeOrchestrationOutcomeChange(before, after)
    await Promise.resolve()
    expect(requests(observer)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'orchestration.routing' }),
        expect.objectContaining({
          capability: 'orchestration.done_when',
          state: expect.objectContaining({
            activeAttemptCount: null,
            attemptPopulationComplete: false,
            evidenceComplete: true
          })
        })
      ])
    )
    expectBounded(reads)
    expect(changedAttempts).toEqual(preservedAttempts)
    expect(changedOutcomes).toEqual(preservedOutcomes)
    expect(after.outcomeSet!.attempts.length).toBe(HISTORY_LENGTH)
  })

  it('finds recent verdict receipts without reading ancient steps or verdict bodies', async () => {
    const reads = audit()
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = emptyChain()
    const after = emptyChain()
    const steps = recent((index) => judge(`judge-${index}`))
    let privateReads = 0
    const receipts = recent((index) => ({
      stepId: `judge-${index}`,
      attemptId: `attempt-${index}`,
      consumptionKey: `receipt-${index}`,
      consumedAt: index,
      verdict: {
        status: 'pass',
        blockingFindings: [],
        get notes() {
          privateReads++
          throw new Error('Private verdict body was read')
        }
      }
    }))
    after.steps = history(steps, reads)
    after.verdicts = history(receipts, reads)
    observeOrchestrationOutcomeChange(before, after)
    await Promise.resolve()
    expect(requests(observer)).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'orchestration.judge' })])
    )
    expect(privateReads).toBe(0)
    expectBounded(reads)
    expect(after.steps.length).toBe(HISTORY_LENGTH)
    expect(after.verdicts.length).toBe(HISTORY_LENGTH)
  })

  it.each(['conditions', 'evidence', 'both'] as const)(
    'does not present sampled %s as complete condition proof',
    async (field) => {
      const reads = audit()
      const observer = vi.fn()
      installOrchestrationShadowObserver(observer)
      const before = emptyChain()
      const after = emptyChain()
      const outcome = planReportOutcome()
      outcome.conditions = recent((index) => ({
        ...outcome.conditions[0]!,
        id: `condition-${index}`
      }))
      outcome.evidence = recent((index) => ({
        ...outcome.evidence[0]!,
        conditionId: `condition-${index}`,
        id: `evidence-${index}`
      }))
      before.outcomeSet!.outcomes = [structuredClone(outcome)]
      outcome.revision++
      outcome.evidence.forEach((entry) => {
        entry.outcomeRevision = outcome.revision
      })
      const preservedConditions = structuredClone(outcome.conditions)
      const preservedEvidence = structuredClone(outcome.evidence)
      const sourceConditions = outcome.conditions
      const sourceEvidence = outcome.evidence
      if (field !== 'evidence') {
        outcome.conditions = history(sourceConditions, reads)
      }
      if (field !== 'conditions') {
        outcome.evidence = history(sourceEvidence, reads)
      }
      after.outcomeSet!.outcomes = [outcome]
      observeOrchestrationOutcomeChange(before, after)
      await Promise.resolve()
      const observed = requests(observer).find(
        (request) => request.capability === 'orchestration.done_when'
      )
      expect(observed?.state).toMatchObject({
        provenConditionCount: null,
        evidenceComplete: false
      })
      expectBounded(reads)
      expect(sourceConditions).toEqual(preservedConditions)
      expect(sourceEvidence).toEqual(preservedEvidence)
    }
  )

  it('shares a finite read budget across nested review groups, rounds and receipts', async () => {
    const reads = audit()
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = emptyChain()
    const after = emptyChain()
    after.steps = [judge('recent-judge')]
    const groups: SessionReviewGroupState[] = recent((index) => ({
      id: `group-${index}`,
      maxRounds: HISTORY_LENGTH,
      currentRound: HISTORY_LENGTH,
      status: 'reviewing',
      consumedRepairKeys: [],
      rounds: history(
        recent((round) => ({
          index: round + 1,
          candidateVersion: 'current',
          receipts: history(
            recent((receipt) => ({
              stepId: 'recent-judge',
              reviewerId: 'codex',
              candidateVersion: 'current',
              status: 'pass' as const,
              blockingFindings: [],
              recordedAt: receipt
            })),
            reads
          )
        })),
        reads
      )
    }))
    before.reviewLoop = { groups: groups.map((group) => ({ ...group, rounds: [] })) }
    after.reviewLoop = { groups: history(groups, reads) }
    observeOrchestrationOutcomeChange(before, after)
    await Promise.resolve()
    expect(requests(observer)).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'orchestration.judge' })])
    )
    expectBounded(reads)
    expect(groups[0]!.rounds.length).toBe(HISTORY_LENGTH)
  })

  it('marks sampled handoff delivery and receipt counts incomplete', async () => {
    const reads = audit()
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = emptyChain()
    const after = emptyChain()
    const handoff: SessionChainHandoffStep = {
      kind: 'handoff',
      id: 'handoff',
      status: 'delivered',
      handoff: {
        revision: 1,
        taskId: null,
        taskTitle: 'Private title',
        sessionLabel: 'Private label',
        recipients: [],
        deliverables: { kind: 'files', paths: [] },
        includeSummary: true,
        note: 'Private note',
        savedAt: 1,
        capturedAt: 2
      }
    }
    before.steps = [structuredClone(handoff)]
    handoff.handoff.recipients = history(
      recent((index) => ({
        employeeId: `emp_${index}`,
        name: 'Private name',
        operationId: `operation-${index}`,
        delivery: 'sent' as const,
        threadId: `hth_${index}`
      })),
      reads
    )
    after.steps = [handoff]
    observeOrchestrationOutcomeChange(before, after)
    await Promise.resolve()
    const observed = requests(observer).find(
      (request) => request.capability === 'orchestration.handoff'
    )
    expect(observed?.state).toMatchObject({
      sent: null,
      receiptCount: null,
      evidenceComplete: false
    })
    expectBounded(reads)
  })

  it.each(['paneKey', 'hookEventName', 'toolName'] as const)(
    'rejects oversized %s without reading private tool input',
    async (field) => {
      const observer = vi.fn()
      installOrchestrationShadowObserver(observer)
      let privateReads = 0
      const event: AgentHookEventPayload = {
        paneKey: 'pane',
        connectionId: null,
        source: 'claude',
        hookEventName: 'PreToolUse',
        payload: {
          state: 'working',
          prompt: '',
          toolName: 'Bash',
          get toolInput(): string {
            privateReads++
            throw new Error('Private tool input was inspected')
          }
        }
      }
      const oversized = 'x'.repeat(ORCHESTRATION_SHADOW_LIMITS.referenceChars + 1)
      if (field === 'toolName') {
        event.payload.toolName = oversized
      } else {
        event[field] = oversized
      }
      observeOrchestrationToolAction(event)
      await Promise.resolve()
      expect(observer).not.toHaveBeenCalled()
      expect(privateReads).toBe(0)
      observeOrchestrationToolAction({
        paneKey: 'pane',
        connectionId: null,
        hookEventName: 'PreToolUse',
        payload: { state: 'working', prompt: '', toolName: 'Bash' }
      })
      await Promise.resolve()
      expect(observer).toHaveBeenCalled()
    }
  )

  it('does not touch chain sources while admission is full', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    for (let index = 0; index < 64; index++) {
      observeOrchestrationToolAction({
        paneKey: 'pane',
        connectionId: null,
        source: 'claude',
        hookEventName: 'PreToolUse',
        payload: { state: 'working', prompt: '', toolName: 'Bash' }
      })
    }
    let sourceReads = 0
    const source = new Proxy(emptyChain(), {
      get() {
        sourceReads++
        throw new Error('Chain was inspected after admission filled')
      }
    })
    observeOrchestrationOutcomeChange(source, source)
    await Promise.resolve()
    expect(sourceReads).toBe(0)
    expect(observer).toHaveBeenCalled()
    expect(
      requests(observer).every((request) => request.capability === 'orchestration.tool_action')
    ).toBe(true)
  })
})
