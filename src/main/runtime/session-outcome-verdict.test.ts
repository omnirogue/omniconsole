import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real candidate version shells out to git; these rows are about what a verdict decides, not
// about hashing a workspace, so the seam is stubbed exactly as its neighbouring tests stub it.
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import { SESSION_VERDICT_MARKER } from '../../shared/session-chain-verdict'
import { sessionVerdictConsumptionKey } from '../../shared/session-chain-verdict-receipts'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { OrcaRuntimeService } from './omni-runtime'
import { verifySessionOutcomeReport } from './session-outcome-report-evidence'
import { finishReviewRound } from './session-outcome-review-round'
import type { OutcomeStepAccess } from './session-outcome-step-progress'
import { sessionOutcomeGateHold } from './session-outcome-gate-hold'
import { consumeSessionOutcomeVerdict } from './session-outcome-verdict'

type Step = SessionChainAgentStep & { onFail?: string }

const bodies = new Map<string, string>()
const NOW = 7_000

/** The seat already gave back as many attempts as the host may ask for again by itself. */
function spentReasks<T extends { chain(): SessionChain; save(chain: SessionChain): void }>(
  store: T,
  stepId: string
): T {
  const chain = store.chain()
  store.save({
    ...chain,
    outcomeSet: {
      ...chain.outcomeSet!,
      attempts: [
        ...chain.outcomeSet!.attempts,
        ...['first', 'second'].map((id) => ({
          ...attempt(`attempt_${stepId}_${id}`, stepId),
          state: 'retryable' as const
        }))
      ]
    }
  })
  return store
}

function agent(step: Partial<Step> & { id: string }): Step {
  return {
    agent: 'codex',
    prompt: `Work on ${step.id}.`,
    status: 'queued',
    ...step
  }
}

function attempt(id: string, stepId: string): SessionOutcomeAttempt {
  return {
    id,
    outcomeId: 'outcome',
    actionId: `step_${stepId}`,
    actionKey: `key_${stepId}`,
    outcomeRevision: 1,
    state: 'completed',
    taskId: `task_${stepId}`,
    startedAt: 1,
    updatedAt: 2
  }
}

function chainOf(steps: Step[], attempts: SessionOutcomeAttempt[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts,
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'outcome',
          title: 'The export balances',
          revision: 1,
          finish: 'complete',
          status: 'pending',
          evidence: [],
          actions: [],
          dependsOn: [],
          conditions: [
            {
              id: 'done_1',
              kind: 'report',
              target: 'verify',
              label: 'the export keeps the tax column'
            }
          ],
          stepIds: steps.map((step) => step.id)
        }
      ]
    }
  }
}

function access(chain: SessionChain): OutcomeStepAccess & { chain(): SessionChain } {
  let current = chain
  return {
    runtime: {
      getOrchestrationDb: () => ({
        getTask: (id: string) => ({ result: JSON.stringify({ body: bodies.get(id) ?? '' }) })
      })
    } as unknown as OrcaRuntimeService,
    read: () => current,
    save: (updated) => {
      current = updated
    },
    persistAttempt: (entry) => {
      current = {
        ...current,
        outcomeSet: {
          ...current.outcomeSet!,
          attempts: [...current.outcomeSet!.attempts.filter((a) => a.id !== entry.id), entry]
        }
      }
    },
    chain: () => current
  }
}

function verdictLine(payload: Record<string, unknown>): string {
  return `I read every candidate.\n${SESSION_VERDICT_MARKER} ${JSON.stringify(payload)}`
}

const outcomeOf = (chain: SessionChain): SessionOutcome => chain.outcomeSet!.outcomes[0]!
const stepOf = (chain: SessionChain, id: string): Step =>
  chain.steps.find((step) => step.id === id) as Step

/** draft ×2 → judge (select-winner) → polish ×2 → summary → verify (gate) → publish → repair. */
function planChain(): ReturnType<typeof access> {
  return access(
    chainOf(
      [
        agent({ id: 'cand_a', planNodeId: 'draft', group: 'draft', seat: { index: 1, total: 2 } }),
        agent({ id: 'cand_b', planNodeId: 'draft', group: 'draft', seat: { index: 2, total: 2 } }),
        agent({
          id: 'judge',
          planNodeId: 'judge',
          presetId: 'judge',
          verdict: { kind: 'judge', over: ['cand_a', 'cand_b'], consumed: 'select-winner' }
        }),
        agent({
          id: 'polish_a',
          planNodeId: 'polish',
          seat: { index: 1, total: 2 },
          enabledBy: { verdict: 'judge', seatsOf: 'draft' }
        }),
        agent({
          id: 'polish_b',
          planNodeId: 'polish',
          seat: { index: 2, total: 2 },
          enabledBy: { verdict: 'judge', seatsOf: 'draft' }
        }),
        agent({ id: 'summary', planNodeId: 'summary', readsWinnerOf: 'judge' }),
        agent({
          id: 'verify',
          planNodeId: 'verify',
          presetId: 'verify',
          verdict: { kind: 'verify', over: ['done_1'], consumed: 'gate' },
          onFail: 'repair'
        }),
        agent({ id: 'publish', planNodeId: 'publish' }),
        agent({ id: 'repair', planNodeId: 'repair', presetId: 'repair' })
      ],
      [attempt('attempt_judge', 'judge'), attempt('attempt_verify', 'verify')]
    )
  )
}

const JUDGEMENT = {
  kind: 'judge',
  status: 'pass',
  stepId: 'judge',
  attemptId: 'attempt_judge',
  candidateVersion: 'candidate-1',
  winnerId: 'cand_b',
  blockingFindings: [],
  scores: [
    { candidateId: 'cand_a', score: 41, rationale: 'drops the tax column' },
    { candidateId: 'cand_b', score: 90, rationale: 'complete' }
  ]
}

const CHECK_STATUS: Record<string, string> = {
  pass: 'pass',
  fail: 'fail',
  findings: 'fail',
  insufficient_evidence: 'unknown'
}

function gate(status: string, findings: string[] = []): Record<string, unknown> {
  return {
    kind: 'verify',
    status,
    stepId: 'verify',
    attemptId: 'attempt_verify',
    candidateVersion: 'candidate-1',
    blockingFindings: findings,
    checks: [
      { id: 'done_1', status: CHECK_STATUS[status] ?? 'unknown', evidence: 'ran the export check' }
    ]
  }
}

beforeEach(() => {
  bodies.clear()
})

describe('consuming a select-winner verdict', () => {
  it('spends it once, closes the seats it did not select and resolves the winner reader', async () => {
    bodies.set('task_judge', verdictLine(JUDGEMENT))
    const store = planChain()
    const chain = store.chain()
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        chain,
        outcomeOf(chain),
        stepOf(chain, 'judge'),
        chain.outcomeSet!.attempts[0]!
      )
    ).toBe('applied')
    const after = store.chain()
    expect(after.verdicts).toHaveLength(1)
    expect(after.verdicts![0]).toMatchObject({
      stepId: 'judge',
      attemptId: 'attempt_judge',
      consumptionKey: 'verdict:judge:attempt_judge'
    })
    expect(after.outcomeSet!.completedSteps).toContain('judge')
    // Seat 1 lost, seat 2 won: only the loser's seat is closed, and the winner's keeps running.
    expect(stepOf(after, 'polish_a').status).toBe('skipped')
    expect(after.outcomeSet!.completedSteps).toContain('polish_a')
    expect(stepOf(after, 'polish_b').status).toBe('queued')
    expect(after.outcomeSet!.completedSteps).not.toContain('polish_b')
    expect(stepOf(after, 'summary').readsFrom).toEqual(['cand_b'])
    expect(outcomeOf(after).status).not.toBe('blocked')
  })

  it('is a no-op when the same attempt is consumed again', async () => {
    bodies.set('task_judge', verdictLine(JUDGEMENT))
    const store = planChain()
    const first = store.chain()
    await consumeSessionOutcomeVerdict(
      store,
      first,
      outcomeOf(first),
      stepOf(first, 'judge'),
      first.outcomeSet!.attempts[0]!
    )
    const between = store.chain()
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        between,
        outcomeOf(between),
        stepOf(between, 'judge'),
        between.outcomeSet!.attempts[0]!
      )
    ).toBe('replayed')
    expect(store.chain().verdicts).toHaveLength(1)
  })

  it('refuses a winner named without scoring every candidate exactly once', async () => {
    bodies.set('task_judge', verdictLine({ ...JUDGEMENT, scores: undefined }))
    const store = spentReasks(planChain(), 'judge')
    const chain = store.chain()
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        chain,
        outcomeOf(chain),
        stepOf(chain, 'judge'),
        chain.outcomeSet!.attempts[0]!
      )
    ).toBe('failed')
    expect(outcomeOf(store.chain()).blockedReason).toContain('scoring every candidate')
    expect(outcomeOf(store.chain()).block).toMatchObject({
      class: 'failed',
      code: 'verdict-unreadable'
    })
    expect(store.chain().verdicts ?? []).toHaveLength(0)
  })
})

describe('refusing a verdict', () => {
  const REFUSALS: [string, string, string][] = [
    [
      'an envelope issued by another attempt',
      verdictLine({ ...JUDGEMENT, attemptId: 'attempt_from_a_candidate' }),
      'verdict identity differs from its attempt'
    ],
    [
      'a report carrying a second marker',
      `${verdictLine(JUDGEMENT)}\n${SESSION_VERDICT_MARKER} ${JSON.stringify(JUDGEMENT)}`,
      'more than one verdict line'
    ],
    ['a report with no verdict at all', 'The drafts both look fine to me.', 'no verdict line']
  ]

  it.each(REFUSALS)('asks the seat again first on %s', async (_name, body) => {
    bodies.set('task_judge', body)
    const store = planChain()
    const chain = store.chain()
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        chain,
        outcomeOf(chain),
        stepOf(chain, 'judge'),
        chain.outcomeSet!.attempts[0]!,
        NOW
      )
    ).toBe('reasked')
    const after = store.chain()
    // The attempt is given back, so the cohort launches exactly this seat again. It is not a
    // failed step, not a blocked outcome and not a question for anyone.
    expect(after.outcomeSet!.attempts[0]).toMatchObject({ id: 'attempt_judge', state: 'retryable' })
    expect(stepOf(after, 'judge').status).toBe('queued')
    expect(outcomeOf(after).status).not.toBe('blocked')
    expect(after.outcomeSet!.attention ?? []).toEqual([])
    expect(after.outcomeSet!.completedSteps).not.toContain('judge')
    expect(after.verdicts ?? []).toHaveLength(0)
  })

  it.each(REFUSALS)(
    'fails the step and blocks the outcome on %s once the re-asks are spent',
    async (_name, body, reason) => {
      bodies.set('task_judge', body)
      const store = spentReasks(planChain(), 'judge')
      const chain = store.chain()
      expect(
        await consumeSessionOutcomeVerdict(
          store,
          chain,
          outcomeOf(chain),
          stepOf(chain, 'judge'),
          chain.outcomeSet!.attempts[0]!
        )
      ).toBe('failed')
      const after = store.chain()
      expect(stepOf(after, 'judge').status).toBe('failed')
      expect(outcomeOf(after).status).toBe('blocked')
      expect(outcomeOf(after).blockedReason?.toLowerCase()).toContain(reason.toLowerCase())
      // An honest operational failure: no verdict is never a request for a person.
      expect(outcomeOf(after).block).toMatchObject({ class: 'failed', code: 'verdict-unreadable' })
      expect(readSessionRun(after.outcomeSet!, { now: NOW })).toMatchObject({
        phase: 'failed',
        attention: []
      })
      expect(after.outcomeSet!.attempts[0]).toMatchObject({
        id: 'attempt_judge',
        state: 'completed'
      })
      expect(after.outcomeSet!.completedSteps).not.toContain('judge')
      expect(after.verdicts ?? []).toHaveLength(0)
      // A judge that decided nothing may not let the first candidate walk on as if it had won.
      expect(stepOf(after, 'polish_a').status).toBe('queued')
      expect(stepOf(after, 'polish_b').status).toBe('queued')
      expect(stepOf(after, 'summary').readsFrom).toBeUndefined()
    }
  )
})

describe('a review report is evaluation, not completion', () => {
  const reviewed = (status: 'pass' | 'findings' | 'insufficient_evidence'): SessionChain => {
    bodies.set('task_review_seat', 'review.md written')
    const chain = chainOf(
      [agent({ id: 'cand_a' }), reviewSeat('review_seat', 1, 'first')],
      [attempt('attempt_review', 'review_seat')]
    )
    return {
      ...chain,
      reviewLoop: {
        groups: [
          {
            id: 'review_group',
            maxRounds: 2,
            currentRound: 1,
            status: status === 'pass' ? 'passed' : 'report-complete',
            consumedRepairKeys: [],
            rounds: [
              {
                index: 1,
                candidateVersion: 'candidate-1',
                receipts: [
                  {
                    stepId: 'review_seat',
                    reviewerId: 'first',
                    candidateVersion: 'candidate-1',
                    status,
                    blockingFindings: status === 'pass' ? [] : ['the tax column is missing'],
                    recordedAt: 3
                  }
                ]
              }
            ]
          }
        ]
      },
      outcomeSet: {
        ...chain.outcomeSet!,
        completedSteps: ['cand_a', 'review_seat'],
        outcomes: [
          {
            ...chain.outcomeSet!.outcomes[0]!,
            conditions: [{ id: 'done_1', kind: 'report', target: 'review_seat' }]
          }
        ]
      },
      verdicts: [
        {
          stepId: 'review_seat',
          attemptId: 'attempt_review',
          verdict: { status },
          consumptionKey: 'verdict:review_seat:attempt_review',
          consumedAt: 4
        }
      ]
    }
  }

  // On the tip a `report` condition was met by ANY reviewer receipt that had not crashed, so a
  // review that asked for changes still read as done. Only a pass is proof.
  it.each([
    ['findings', 'The report names blocking findings, so it is not proof that this is done.'],
    [
      'insufficient_evidence',
      'The verifier could not judge this report; supply the evidence it named and verify again.'
    ]
  ] as const)('refuses a report condition on a %s receipt', async (status, reason) => {
    const chain = reviewed(status)
    const store = access(chain)
    expect(
      await verifySessionOutcomeReport(outcomeOf(chain).conditions[0]!, store.runtime, chain)
    ).toEqual({ verified: false, reason })
  })

  it('still accepts the reviewer receipt that passed on this version', async () => {
    const chain = reviewed('pass')
    const store = access(chain)
    const result = await verifySessionOutcomeReport(
      outcomeOf(chain).conditions[0]!,
      store.runtime,
      chain
    )
    expect(result).toMatchObject({ verified: true, version: 'candidate-1' })
  })
})

async function consumeGate(status: string, findings: string[] = [], route = true) {
  bodies.set('task_verify', verdictLine(gate(status, findings)))
  const store = planChain()
  const chain = store.chain()
  const step = stepOf(chain, 'verify')
  const result = await consumeSessionOutcomeVerdict(
    store,
    chain,
    outcomeOf(chain),
    route ? step : ({ ...step, onFail: undefined } as Step),
    chain.outcomeSet!.attempts[1]!
  )
  return { store, result }
}

describe('consuming a gate verdict', () => {
  it('mints one done-when receipt per entry it decides, and closes the repair it did not need', async () => {
    const { store, result } = await consumeGate('pass')
    expect(result).toBe('applied')
    const after = store.chain()
    const evidence = outcomeOf(after).evidence
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ conditionId: 'done_1', kind: 'report', target: 'verify' })
    expect(evidence[0]!.receipt).toMatch(/^report:attempt_verify:[a-f0-9]{64}$/)
    expect(stepOf(after, 'repair').status).toBe('skipped')
    expect(stepOf(after, 'publish').status).toBe('queued')
    expect(outcomeOf(after).status).not.toBe('blocked')
    // The tick re-verifies the same condition; it must read the receipt the gate minted, not a
    // different one, or the evidence is invalidated and re-recorded on every pass.
    const verified = await verifySessionOutcomeReport(
      outcomeOf(after).conditions[0]!,
      store.runtime,
      after
    )
    expect(verified).toEqual({
      verified: true,
      version: 'candidate-1',
      receipt: evidence[0]!.receipt
    })
  })

  it('proves only the lines a per-line receipt passed when the tick re-reads it', async () => {
    const { store } = await consumeGate('pass')
    const after = store.chain()
    const unchecked = { id: 'done_2', kind: 'report' as const, target: 'verify' }
    await expect(verifySessionOutcomeReport(unchecked, store.runtime, after)).resolves.toEqual({
      verified: false,
      reason: 'The verifier did not pass this Done When line.'
    })
  })

  it('never replays a stored gate receipt written before per-line checks as decided', async () => {
    const store = planChain()
    const chain = store.chain()
    const { checks: _none, ...legacy } = gate('pass')
    store.save({
      ...chain,
      verdicts: [
        {
          stepId: 'verify',
          attemptId: 'attempt_verify',
          verdict: { ...legacy, marker: 'verdict' },
          consumptionKey: sessionVerdictConsumptionKey('verify', 'attempt_verify'),
          consumedAt: 1
        }
      ]
    })
    const before = store.chain()
    const result = await consumeSessionOutcomeVerdict(
      store,
      before,
      outcomeOf(before),
      stepOf(before, 'verify'),
      before.outcomeSet!.attempts[1]!
    )
    expect(result).toBe('failed')
    expect(outcomeOf(store.chain()).evidence).toHaveLength(0)
    expect(store.chain().outcomeSet!.completedSteps).not.toContain('verify')
  })

  it('asks again, and receipts nothing, when a verify verdict skips a Done When line', async () => {
    const { checks: _omitted, ...unchecked } = gate('pass')
    bodies.set('task_verify', verdictLine(unchecked))
    const store = planChain()
    const chain = store.chain()
    const result = await consumeSessionOutcomeVerdict(
      store,
      chain,
      outcomeOf(chain),
      stepOf(chain, 'verify'),
      chain.outcomeSet!.attempts[1]!
    )
    expect(result).toBe('reasked')
    expect(outcomeOf(store.chain()).evidence).toHaveLength(0)
  })

  it('asks again when a verify verdict checks a line it was not given', async () => {
    bodies.set(
      'task_verify',
      verdictLine({
        ...gate('pass'),
        checks: [
          { id: 'done_1', status: 'pass', evidence: 'ran it' },
          { id: 'done_9', status: 'pass', evidence: 'invented' }
        ]
      })
    )
    const store = planChain()
    const chain = store.chain()
    const result = await consumeSessionOutcomeVerdict(
      store,
      chain,
      outcomeOf(chain),
      stepOf(chain, 'verify'),
      chain.outcomeSet!.attempts[1]!
    )
    expect(result).toBe('reasked')
    expect(outcomeOf(store.chain()).evidence).toHaveLength(0)
  })

  it('mints nothing and routes the failure to the repair the plan named', async () => {
    const { store, result } = await consumeGate('fail', ['row 12 has no tax column'])
    expect(result).toBe('applied')
    const after = store.chain()
    expect(outcomeOf(after).evidence).toHaveLength(0)
    expect(outcomeOf(after).status).not.toBe('blocked')
    expect(after.outcomeSet!.completedSteps).toContain('verify')
    // Everything between the gate and its repair is closed, so the run continues AT the repair.
    expect(stepOf(after, 'publish').status).toBe('skipped')
    expect(stepOf(after, 'repair').status).toBe('queued')
    expect(after.outcomeSet!.completedSteps).not.toContain('repair')
  })

  it('stops at a failure with nowhere to go, and never passes on "could not judge"', async () => {
    const blocked = await consumeGate('findings', ['the ledger was never opened'], false)
    expect(blocked.result).toBe('applied')
    const stopped = blocked.store.chain()
    expect(outcomeOf(stopped).blockedReason).toContain('did not pass')
    expect(outcomeOf(stopped).evidence).toHaveLength(0)
    // Stages are still to run, and none of them may: the stop is the owner's decision, asked once
    // here and re-derived from the record by every later pass (`session-outcome-gate-hold.ts`).
    expect(stopped.outcomeSet!.attention).toMatchObject([
      {
        kind: 'decision',
        state: 'open',
        source: { type: 'verification-gate', ref: 'the ledger was never opened' },
        scope: { outcomeId: 'outcome', stepId: 'verify' }
      }
    ])
    expect(outcomeOf(stopped).block).toMatchObject({
      class: 'attention',
      code: 'verification-gate',
      attentionIds: [stopped.outcomeSet!.attention![0]!.id]
    })
    // The gate and every seat behind it are held for that decision, in the receipt's own write.
    for (const id of ['verify', 'publish', 'repair']) {
      expect(stepOf(stopped, id).wait).toMatchObject({ reason: 'human_decision', ref: 'verify' })
    }
    expect(stepOf(stopped, 'summary').wait).toBeUndefined()
    expect(sessionOutcomeGateHold(stopped, stopped.outcomeSet!, outcomeOf(stopped))).toMatchObject({
      kind: 'gate',
      stepId: 'verify'
    })
    const unjudged = await consumeGate('insufficient_evidence', ['no run log was produced'])
    expect(unjudged.result).toBe('applied')
    expect(outcomeOf(unjudged.store.chain()).blockedReason).toContain('could not judge')
    expect(outcomeOf(unjudged.store.chain()).block).toMatchObject({
      class: 'failed',
      code: 'review-insufficient-evidence'
    })
    expect(unjudged.store.chain().outcomeSet!.attention ?? []).toEqual([])
    expect(outcomeOf(unjudged.store.chain()).evidence).toHaveLength(0)
    // Even with a repair to route to, an unjudgeable verification stops instead of repairing.
    expect(stepOf(unjudged.store.chain(), 'publish').status).toBe('queued')
    expect(stepOf(unjudged.store.chain(), 'publish').wait).toMatchObject({
      reason: 'human_decision',
      ref: 'verify'
    })
  })

  it('holds nothing behind a gate that passed, or one whose failure the plan routes', async () => {
    for (const routed of [await consumeGate('pass'), await consumeGate('fail', ['row 12'])]) {
      const after = routed.store.chain()
      expect(after.steps.filter((step) => step.kind !== 'handoff' && step.wait)).toEqual([])
      expect(sessionOutcomeGateHold(after, after.outcomeSet!, outcomeOf(after))).toBeUndefined()
    }
  })

  it('asks the owner to decide once a failed gate with no route leaves nothing else to run', async () => {
    bodies.set('task_verify', verdictLine(gate('fail', ['the ledger was never opened'])))
    const store = planChain()
    const initial = store.chain()
    store.save({
      ...initial,
      outcomeSet: {
        ...initial.outcomeSet!,
        completedSteps: initial.steps.map((step) => step.id).filter((id) => id !== 'verify')
      }
    })
    const ready = store.chain()
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        ready,
        outcomeOf(ready),
        { ...stepOf(ready, 'verify'), onFail: undefined } as Step,
        ready.outcomeSet!.attempts[1]!,
        NOW
      )
    ).toBe('applied')
    const after = store.chain()
    const run = readSessionRun(after.outcomeSet!, { now: NOW })
    expect(run.phase).toBe('needs-you')
    expect(run.attention).toMatchObject([
      {
        kind: 'decision',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next' },
        source: { type: 'verification-gate', ref: 'the ledger was never opened' },
        scope: { outcomeId: 'outcome', stepId: 'verify' },
        openedAt: NOW
      }
    ])
    expect(outcomeOf(after).block).toMatchObject({
      class: 'attention',
      code: 'verification-gate',
      attentionIds: [run.attention[0]!.id]
    })
  })

  it('refuses a report receipt that is not a pass, and one with no receipt at all', async () => {
    const { store } = await consumeGate('findings', ['row 12 has no tax column'])
    const after = store.chain()
    expect(
      await verifySessionOutcomeReport(outcomeOf(after).conditions[0]!, store.runtime, after)
    ).toEqual({
      verified: false,
      reason: 'The report names blocking findings, so it is not proof that this is done.'
    })
    // The runtime invariant: completed, no receipt, nothing proven.
    const forged = {
      ...after,
      verdicts: [],
      outcomeSet: { ...after.outcomeSet!, completedSteps: ['verify'] }
    }
    const refusal = await verifySessionOutcomeReport(
      outcomeOf(forged).conditions[0]!,
      store.runtime,
      forged
    )
    expect(refusal).toEqual({
      verified: false,
      reason: 'Verdict without receipt: verify completed without deciding anything.'
    })
  })
})

describe('consuming a record verdict', () => {
  it('writes the receipt and changes nothing else', async () => {
    bodies.set('task_judge', verdictLine({ ...JUDGEMENT, scores: undefined, winnerId: undefined }))
    const store = planChain()
    const chain = store.chain()
    const step = { ...stepOf(chain, 'judge') }
    step.verdict = { kind: 'critique', over: ['cand_a', 'cand_b'], consumed: 'record' }
    expect(
      await consumeSessionOutcomeVerdict(
        store,
        chain,
        outcomeOf(chain),
        step,
        chain.outcomeSet!.attempts[0]!
      )
    ).toBe('applied')
    const after = store.chain()
    expect(after.verdicts).toHaveLength(1)
    expect(after.outcomeSet!.completedSteps).toEqual(['judge'])
    expect(stepOf(after, 'polish_a').status).toBe('queued')
    expect(outcomeOf(after).evidence).toHaveLength(0)
  })
})

function reviewSeat(id: string, round: number, reviewerId: string): Step {
  return agent({
    id,
    planNodeId: 'review',
    presetId: 'review',
    group: `review_round_${round}`,
    verdict: { kind: 'review', over: ['cand_a'], consumed: 'record' },
    review: {
      groupId: 'review_group',
      reviewerId,
      round,
      maxRounds: 2,
      candidateVersion: 'candidate-1'
    }
  })
}

describe('a review round that completes a seat without a verdict', () => {
  const pass = (stepId: string): string =>
    verdictLine({
      kind: 'review',
      status: 'pass',
      stepId,
      attemptId: `attempt_${stepId}`,
      candidateVersion: 'candidate-1',
      blockingFindings: []
    })

  it('records the skip when the round is still running, and when the group closes', async () => {
    bodies.set('task_r1_1', pass('r1_1'))
    bodies.set('task_r2_1', pass('r2_1'))
    const steps = [
      agent({ id: 'cand_a', planNodeId: 'draft' }),
      reviewSeat('r1_1', 1, 'first'),
      reviewSeat('r2_1', 1, 'second'),
      reviewSeat('r1_2', 2, 'first'),
      reviewSeat('r2_2', 2, 'second')
    ]
    const running: SessionOutcomeAttempt = { ...attempt('attempt_r2_1', 'r2_1'), state: 'running' }
    const store = access(chainOf(steps, [attempt('attempt_r1_1', 'r1_1'), running]))
    const first = store.chain()
    await finishReviewRound(store, outcomeOf(first), stepOf(first, 'r1_1'))
    const parked = store.chain()
    expect(parked.outcomeSet!.completedSteps).toEqual(['r1_1'])
    expect(parked.verdicts).toHaveLength(1)
    expect(parked.verdicts![0]).toMatchObject({
      stepId: 'r1_1',
      attemptId: 'attempt_r1_1',
      skipped: true
    })
    expect(outcomeOf(parked).status).not.toBe('blocked')

    store.persistAttempt(attempt('attempt_r2_1', 'r2_1'))
    const ready = store.chain()
    await finishReviewRound(store, outcomeOf(ready), stepOf(ready, 'r2_1'))
    const closed = store.chain()
    // The round passed, so its later seats are closed — each with the receipt that says why.
    expect(closed.outcomeSet!.completedSteps).toEqual(
      expect.arrayContaining(['r1_1', 'r2_1', 'r1_2', 'r2_2'])
    )
    for (const id of ['r1_2', 'r2_2']) {
      expect(closed.verdicts!.find((entry) => entry.stepId === id)).toMatchObject({ skipped: true })
    }
    expect(outcomeOf(closed).blockedReason ?? '').toBe('')
    // The seats that DID decide carry their decision, not a skip.
    expect(
      closed.verdicts!.find((entry) => entry.stepId === 'r2_1' && !entry.skipped)
    ).toMatchObject({ attemptId: 'attempt_r2_1', verdict: { status: 'pass' } })
  })
})
