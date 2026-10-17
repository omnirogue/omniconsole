import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_VERDICT_MARKER } from '../../shared/session-chain-verdict'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { blockOutcomesWithoutVerdictReceipt } from './session-outcome-verdict-invariant'
import { registerSessionOutcomeVerdictHandling } from './session-outcome-verdict-register'
import {
  consumeVerdictForStep,
  setSessionOutcomeVerdictConsumer,
  setSessionOutcomeVerdictInstructions,
  verdictInstructionsFor
} from './session-outcome-verdict-hook'

const judge = {
  id: 'judge',
  agent: 'codex',
  prompt: 'Pick the winner',
  status: 'queued',
  verdict: { kind: 'judge', over: ['cand_a', 'cand_b'], consumed: 'select-winner' }
} as SessionChainAgentStep

const gate = {
  id: 'verify',
  agent: 'codex',
  prompt: 'Verify it',
  status: 'queued',
  verdict: { kind: 'verify', over: ['done_1'], consumed: 'gate' }
} as SessionChainAgentStep

const outcome = {
  id: 'ship',
  title: 'The export balances',
  revision: 1,
  finish: 'complete',
  status: 'pending',
  evidence: [],
  actions: [],
  dependsOn: [],
  stepIds: ['cand_a', 'cand_b', 'judge', 'verify'],
  conditions: [
    { id: 'done_1', kind: 'report', target: 'verify', label: 'the export keeps the tax column' },
    { id: 'done_2', kind: 'file', target: '/workspace/export.csv' }
  ]
} as unknown as SessionOutcome

function chainOf(completedSteps: string[], verdicts?: SessionChain['verdicts']): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    steps: [
      { id: 'cand_a', agent: 'codex', prompt: 'a', status: 'queued' },
      { id: 'cand_b', agent: 'codex', prompt: 'b', status: 'queued' },
      judge,
      gate
    ],
    ...(verdicts ? { verdicts } : {}),
    outcomeSet: {
      revision: 1,
      attempts: [],
      completedSteps,
      continuation: { state: 'owned' },
      outcomes: [outcome]
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
}

function access(chain: SessionChain) {
  let current = chain
  return {
    runtime: {
      getOrchestrationDb: () => ({
        getTask: () => ({ result: JSON.stringify({ body: 'no verdict here' }) })
      })
    } as unknown as OrcaRuntimeService,
    read: () => current,
    save: (updated: SessionChain) => {
      current = updated
    },
    persistAttempt: () => {},
    chain: () => current
  }
}

afterEach(() => {
  setSessionOutcomeVerdictConsumer(null)
  setSessionOutcomeVerdictInstructions(null)
})

describe('registering the verdict package at host start', () => {
  it('makes a completed verdict seat reach the real consumer instead of nobody', async () => {
    const store = access(chainOf([]))
    const attempt = { id: 'attempt_judge', actionId: 'step_judge' } as SessionOutcomeAttempt
    // Unwired, the host spends nothing at all and the seat's decision is prose.
    expect(await consumeVerdictForStep(store, store.chain(), outcome, judge, attempt)).toBe(
      'unwired'
    )

    registerSessionOutcomeVerdictHandling()

    // Wired, the SAME call reads the report: this one carries no envelope, so the seat fails and
    // the outcome blocks — which only the real consumer does.
    expect(await consumeVerdictForStep(store, store.chain(), outcome, judge, attempt)).toBe(
      'failed'
    )
    const after = store.chain()
    expect(after.steps.find((step) => step.id === 'judge')).toMatchObject({ status: 'failed' })
    expect(after.outcomeSet!.outcomes[0]).toMatchObject({ status: 'blocked' })
    expect(after.outcomeSet!.completedSteps).not.toContain('judge')
  })

  it('ends a judge brief with one filled envelope naming the seat, the version and the candidates', () => {
    registerSessionOutcomeVerdictHandling()
    const suffix = verdictInstructionsFor(judge, outcome, 'candidate-1')

    expect(suffix.match(new RegExp(SESSION_VERDICT_MARKER, 'g'))).toHaveLength(1)
    expect(suffix).toContain('- cand_a')
    expect(suffix).toContain('- cand_b')
    expect(suffix).toContain('candidate version: candidate-1')
    expect(suffix).toContain('"stepId":"judge"')
    expect(suffix).toContain('"candidateVersion":"candidate-1"')
    expect(suffix).toContain('distinct whole number')
  })

  it('tells a verify gate which done-when entries it decides, and calls none of them a candidate', () => {
    registerSessionOutcomeVerdictHandling()
    const suffix = verdictInstructionsFor(gate, outcome, 'candidate-1')

    expect(suffix).toContain('done_1: the export keeps the tax column')
    // `over` on a gate is done-when ids, never steps: a verifier must not be told to judge "done_1"
    // as if it were a report it had read.
    expect(suffix).not.toContain('Judge exactly these')
    expect(suffix).not.toContain('done_2')
    expect(suffix).toContain('"kind":"verify"')
  })

  it('adds nothing to a seat that emits no verdict', () => {
    registerSessionOutcomeVerdictHandling()
    expect(
      verdictInstructionsFor(
        { ...judge, verdict: undefined } as SessionChainAgentStep,
        outcome,
        'candidate-1'
      )
    ).toBe('')
  })
})

describe('the runtime invariant over a chain', () => {
  it('blocks the outcome when a verdict seat completed without deciding anything', () => {
    const chain = chainOf(['cand_a', 'cand_b', 'judge'])
    const blocked = blockOutcomesWithoutVerdictReceipt(chain, chain.outcomeSet!)

    expect(blocked!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'Verdict without receipt: judge completed without deciding anything.'
    })
  })

  it('holds when the same seat completed with a receipt, and when it has not completed', () => {
    const receipted = chainOf(
      ['judge'],
      [
        {
          stepId: 'judge',
          attemptId: 'attempt_judge',
          verdict: { status: 'pass' },
          consumptionKey: 'verdict:judge:attempt_judge',
          consumedAt: 1
        }
      ]
    )
    expect(blockOutcomesWithoutVerdictReceipt(receipted, receipted.outcomeSet!)).toBeNull()
    const running = chainOf(['cand_a'])
    expect(blockOutcomesWithoutVerdictReceipt(running, running.outcomeSet!)).toBeNull()
  })

  it('names only the seats of the outcome it blocks', () => {
    const chain = chainOf(['judge', 'verify'])
    const narrowed: SessionChain = {
      ...chain,
      outcomeSet: {
        ...chain.outcomeSet!,
        outcomes: [
          { ...outcome, id: 'first', stepIds: ['cand_a', 'judge'] },
          { ...outcome, id: 'second', stepIds: ['cand_b'] }
        ]
      } as unknown as SessionOutcomeSet
    }
    const blocked = blockOutcomesWithoutVerdictReceipt(narrowed, narrowed.outcomeSet!)

    expect(blocked!.outcomes[0]!.blockedReason).toContain('judge')
    expect(blocked!.outcomes[1]!.status).toBe('pending')
  })
})
