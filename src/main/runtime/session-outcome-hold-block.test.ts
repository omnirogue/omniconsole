import { describe, expect, it } from 'vitest'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainHandoffStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import {
  sessionOutcomeConditionKey,
  type SessionOutcome,
  type SessionOutcomeCondition,
  type SessionOutcomeSet
} from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { SessionOutcomeHold } from './session-outcome-hold-block'
import { holdSessionOutcome } from './session-outcome-hold-write'

const NOW = 1_000_000

function outcomeOf(conditions: SessionOutcomeCondition[], stepIds: string[] = []): SessionOutcome {
  return {
    id: 'outcome',
    title: 'The export balances',
    finish: 'complete',
    dependsOn: [],
    stepIds,
    conditions,
    actions: [],
    revision: 1,
    status: 'pending',
    evidence: []
  }
}

/** `completed` defaults to every step: a verification hold only exists once the work is finished. */
function chainOf(
  outcome: SessionOutcome,
  steps: SessionChainStep[] = [],
  extra: Partial<SessionChain> = {},
  completed: string[] = steps.map((step) => step.id)
): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: steps.length,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: completed,
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [outcome]
    },
    ...extra
  }
}

function proof(outcome: SessionOutcome, conditionId: string, receipt: string) {
  const condition = outcome.conditions.find((entry) => entry.id === conditionId)!
  return {
    id: `proof_${conditionId}`,
    outcomeId: outcome.id,
    conditionId,
    outcomeRevision: outcome.revision,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    ...(condition.version ? { version: condition.version } : {}),
    receipt,
    verifiedAt: 1,
    verifier: 'execution-host' as const
  }
}

function handoffStep(rule: Partial<SessionFollowUpRule>): SessionChainHandoffStep {
  return {
    kind: 'handoff',
    id: 'handoff',
    outcomeId: 'outcome',
    status: 'queued',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Review the export',
      sessionLabel: 'Export',
      recipients: [
        { employeeId: 'emp_maya', name: 'Maya', operationId: 'operation_1', delivery: 'sending' }
      ],
      deliverables: { kind: 'files', paths: [] },
      includeSummary: false,
      note: 'Please review',
      savedAt: 1,
      capturedAt: 2,
      ...rule
    }
  }
}

function held(chain: SessionChain, hold: SessionOutcomeHold) {
  const set = chain.outcomeSet!
  const next = holdSessionOutcome(chain, set, 'outcome', hold, NOW)
  return { set: next, run: readSessionRun(next, { now: NOW }), block: next.outcomes[0]!.block! }
}

describe('a held handoff', () => {
  const DELIVERY: SessionOutcomeCondition = {
    id: 'delivery',
    kind: 'handoff',
    target: 'emp_maya',
    recipientId: 'emp_maya'
  }
  const undelivered = (rule: Partial<SessionFollowUpRule>): SessionChain =>
    chainOf(outcomeOf([DELIVERY], ['handoff']), [handoffStep(rule)], {}, [])
  const unconfirmed = (detail: string, at: number) =>
    undelivered({ exception: { code: 'unconfirmed', subject: 'Maya', detail, at } })

  it('is recovering while an unconfirmed send backs off, and says when the host sends again', () => {
    const chain = unconfirmed('The hub answered without a thread.', NOW - 1_000)
    const reading = held(chain, { kind: 'handoff', stepId: 'handoff', reason: 'unconfirmed' })
    expect(reading.block).toMatchObject({
      class: 'recovering',
      code: 'handoff-unconfirmed',
      until: NOW - 1_000 + 15_000
    })
    expect(reading.run).toMatchObject({ phase: 'recovering', attention: [] })
    expect(reading.run.recoveringUntil).toBe(NOW + 14_000)
  })

  it('fails honestly once the automatic resends are spent, and asks nobody', () => {
    const chain = unconfirmed('timeout [automatic resend 2 of 2]', NOW - 1_000)
    const reading = held(chain, { kind: 'handoff', stepId: 'handoff', reason: 'timeout' })
    expect(reading.block).toMatchObject({ class: 'failed', code: 'handoff-delivery' })
    expect(reading.run).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: [],
      failure: { outcomeId: 'outcome', code: 'handoff-delivery' }
    })
  })

  it('never resends a packaging error: the same files would fail the same way', () => {
    const chain = undelivered({
      exception: { code: 'duplicate-names', subject: 'a.txt', detail: 'Two files', at: NOW }
    })
    expect(
      held(chain, { kind: 'handoff', stepId: 'handoff', reason: 'Two files' }).block
    ).toMatchObject({ class: 'failed', code: 'handoff-duplicate-names' })
  })

  it('waits for deliverables that are not there yet, with the wake that ends the wait', () => {
    const chain = undelivered({ capturedAt: undefined })
    const reading = held(chain, {
      kind: 'handoff',
      stepId: 'handoff',
      reason: 'Handoff deliverables missing: report.md'
    })
    expect(reading.block).toMatchObject({
      class: 'waiting',
      code: 'handoff-deliverables',
      wake: 'deliverables'
    })
    expect(reading.run).toMatchObject({ phase: 'waiting', wake: 'deliverables', attention: [] })
  })
})

describe('a stopped review round', () => {
  const reviewer: SessionChainAgentStep = {
    id: 'r1',
    agent: 'codex',
    prompt: 'Review',
    status: 'queued',
    review: { groupId: 'review', reviewerId: 'r1', round: 1, maxRounds: 1, candidateVersion: 'v1' }
  }
  const round = (status: 'crashed' | 'findings' | 'insufficient_evidence'): SessionChain =>
    chainOf(
      outcomeOf([{ id: 'file', kind: 'file', target: '/workspace/out.txt' }], ['r1']),
      [reviewer],
      { reviewLoop: reviewLoop(status) },
      []
    )
  const reviewLoop = (
    status: 'crashed' | 'findings' | 'insufficient_evidence'
  ): NonNullable<SessionChain['reviewLoop']> => ({
    groups: [
      {
        id: 'review',
        maxRounds: 1,
        currentRound: 1,
        status: 'blocked',
        consumedRepairKeys: [],
        rounds: [
          {
            index: 1,
            candidateVersion: 'v1',
            receipts: [
              {
                stepId: 'r1',
                reviewerId: 'r1',
                candidateVersion: 'v1',
                status,
                blockingFindings: status === 'findings' ? ['Totals are wrong', 'No tests'] : [],
                recordedAt: 1
              }
            ]
          }
        ]
      }
    ]
  })

  it('reads a missing verdict as an operational failure, never as a question', () => {
    const reading = held(round('crashed'), {
      kind: 'review-round',
      groupId: 'review',
      reason: 'A selected reviewer did not return a valid verdict.'
    })
    expect(reading.block).toMatchObject({ class: 'failed', code: 'reviewer-no-verdict' })
    expect(reading.run).toMatchObject({ phase: 'failed', attention: [] })
    expect(reading.set.attention ?? []).toEqual([])
  })

  it('reads a verifier that could not judge as a failure of its own code', () => {
    expect(
      held(round('insufficient_evidence'), {
        kind: 'review-round',
        groupId: 'review',
        reason: 'A selected verifier could not judge.'
      }).block
    ).toMatchObject({ class: 'failed', code: 'review-insufficient-evidence' })
  })

  it('fails a group the step runner held without a judged round: nobody can answer those', () => {
    const unchanged = round('findings')
    unchanged.reviewLoop!.groups[0]!.status = 'repairing'
    const reading = held(unchanged, {
      kind: 'review-round',
      groupId: 'review',
      reason: 'The repair did not revise the reviewed candidate.'
    })
    expect(reading.block).toMatchObject({ class: 'failed', code: 'review-repair-unchanged' })
    expect(reading.run).toMatchObject({ phase: 'failed', attention: [] })
    const unplanned = round('findings')
    delete unplanned.reviewLoop
    expect(
      held(unplanned, {
        kind: 'review-round',
        groupId: 'review',
        reason: 'Repeated review rounds require their authorized repair owner before execution.'
      }).block
    ).toMatchObject({ class: 'failed', code: 'review-plan-invalid' })
  })

  it('gives a review plan that cannot run a code of its own, whatever the group says', () => {
    for (const code of [
      'review-plan-invalid',
      'review-repair-unchanged',
      'review-repair-consumed'
    ] as const) {
      // Even beside a judged, blocked round: what stopped this outcome is the plan, not a verdict.
      const reading = held(round('findings'), {
        kind: 'review-plan',
        groupId: 'review',
        code,
        reason: 'The review loop cannot run as planned.'
      })
      expect(reading.block).toMatchObject({ class: 'failed', code })
      expect(reading.run).toMatchObject({ phase: 'failed', attention: [] })
      expect(reading.set.attention ?? []).toEqual([])
    }
  })

  it('asks the owner for a decision when findings outlive the authorized rounds', () => {
    const reading = held(round('findings'), {
      kind: 'review-round',
      groupId: 'review',
      reason: 'Review findings have no authorized repair owner or remain at the round cap.'
    })
    expect(reading.run.phase).toBe('needs-you')
    expect(reading.run.attention).toMatchObject([
      {
        kind: 'decision',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next' },
        source: { type: 'review-findings' },
        scope: { outcomeId: 'outcome', outcomeRevision: 1, stepId: 'r1' }
      }
    ])
    expect(reading.run.attention[0]!.ask).toContain('2 open review findings')
    expect(reading.block).toMatchObject({
      class: 'attention',
      code: 'review-findings',
      attentionIds: [reading.run.attention[0]!.id]
    })
    // Re-observed by the next pass: the same request, never a second one.
    const again = holdSessionOutcome(
      round('findings'),
      reading.set,
      'outcome',
      { kind: 'review-round', groupId: 'review', reason: 'still findings' },
      NOW + 2_000
    )
    expect(again.attention).toHaveLength(1)
    expect(again.attention![0]!.openedAt).toBe(NOW)
  })
})

describe('a finished outcome whose proof is missing', () => {
  it('waits on evidence the host polls, with the wake named', () => {
    const chain = chainOf(
      outcomeOf([{ id: 'merged', kind: 'merge', target: 'https://example.test/pull/7' }])
    )
    const reading = held(chain, {
      kind: 'verification',
      reason: 'Awaiting verified execution-host evidence.'
    })
    expect(reading.block).toMatchObject({
      class: 'waiting',
      code: 'evidence-poll',
      wake: 'evidence'
    })
    expect(reading.run).toMatchObject({ phase: 'waiting', wake: 'evidence', attention: [] })
  })

  it("waits on a named person's reply, which is their request and never the owner's", () => {
    const delivered = handoffStep({
      recipients: [
        {
          employeeId: 'emp_maya',
          name: 'Maya',
          operationId: 'operation_1',
          delivery: 'sent',
          threadId: 'hth_1'
        }
      ]
    })
    const outcome = outcomeOf(
      [
        { id: 'handoff', kind: 'handoff', target: 'emp_maya', recipientId: 'emp_maya' },
        { id: 'feedback', kind: 'review', target: 'emp_maya', recipientId: 'emp_maya' }
      ],
      ['handoff']
    )
    outcome.evidence = [proof(outcome, 'handoff', 'handoff:hth_1:hth_1:emp_maya')]
    const reading = held(chainOf(outcome, [delivered]), {
      kind: 'verification',
      reason: 'The requested person has not returned a review of the current file versions.'
    })
    expect(reading.block).toMatchObject({ class: 'waiting', code: 'person-review', wake: 'Maya' })
    expect(reading.run).toMatchObject({ phase: 'waiting', wake: 'Maya', attention: [] })
    expect(reading.run.awaitingOthers).toMatchObject([
      {
        kind: 'review',
        recipient: { type: 'person', employeeId: 'emp_maya', name: 'Maya' },
        scope: { conditionId: 'feedback' }
      }
    ])
  })

  it('asks the owner for their own review, with the action that takes them to it', () => {
    const outcome = outcomeOf([
      { id: 'file', kind: 'file', target: '/workspace/result.txt' },
      { id: 'review', kind: 'review', target: 'result', version: 'a'.repeat(64) }
    ])
    outcome.evidence = [proof(outcome, 'file', 'sha256:abc:/workspace/result.txt')]
    const reading = held(chainOf(outcome), {
      kind: 'verification',
      reason: 'Your review is required for this version.'
    })
    expect(reading.run.phase).toBe('needs-you')
    expect(reading.run.attention).toMatchObject([
      {
        kind: 'review',
        recipient: { type: 'owner' },
        action: { kind: 'review-outcome', conditionId: 'review' },
        scope: { outcomeId: 'outcome', conditionId: 'review' }
      }
    ])
    expect(reading.block).toMatchObject({ class: 'attention', code: 'own-review' })
  })

  it('asks for nothing once the approval of this version is on the record', () => {
    const outcome = outcomeOf([
      { id: 'merged', kind: 'merge', target: 'https://example.test/pull/7' },
      { id: 'review', kind: 'review', target: 'result', version: 'a'.repeat(64) }
    ])
    outcome.evidence = [proof(outcome, 'review', `user-review:${'a'.repeat(64)}`)]
    const reading = held(chainOf(outcome), {
      kind: 'verification',
      reason: 'Awaiting verified execution-host evidence.'
    })
    expect(reading.set.attention ?? []).toEqual([])
    expect(reading.run).toMatchObject({ phase: 'waiting', attention: [] })
  })

  it('keeps recovering from a verifier that threw, and fails a deliverable that is not there', () => {
    const chain = chainOf(outcomeOf([{ id: 'file', kind: 'file', target: '/workspace/out.txt' }]))
    expect(
      held(chain, { kind: 'verification', reason: 'Verification failed: EIO' }).block
    ).toMatchObject({ class: 'recovering', code: 'verification-error' })
    const missing = held(chain, {
      kind: 'verification',
      reason: 'The execution host cannot read the expected delivered file.'
    })
    expect(missing.block).toMatchObject({ class: 'failed', code: 'deliverable-unverified' })
    expect(missing.run).toMatchObject({ phase: 'failed', attention: [] })
  })

  it('asks for a decision when the gate that decides a Done When entry failed with no repair left', () => {
    const gate: SessionChainAgentStep = {
      id: 'verify',
      agent: 'claude',
      prompt: 'Verify',
      status: 'queued',
      verdict: { kind: 'verify', over: ['done'], consumed: 'gate' }
    }
    const chain = chainOf(
      outcomeOf([{ id: 'done', kind: 'report', target: 'verify' }], ['verify']),
      [gate]
    )
    chain.verdicts = [
      {
        stepId: 'verify',
        attemptId: 'attempt_verify',
        verdict: { status: 'fail', blockingFindings: ['the tax column is missing'] },
        consumptionKey: 'verdict:verify:attempt_verify',
        consumedAt: 1
      }
    ]
    const reading = held(chain, {
      kind: 'verification',
      reason: 'The report names blocking findings, so it is not proof that this is done.'
    })
    expect(reading.run.phase).toBe('needs-you')
    expect(reading.run.attention).toMatchObject([
      {
        kind: 'decision',
        source: { type: 'verification-gate', ref: 'the tax column is missing' },
        action: { kind: 'open-up-next' },
        scope: { stepId: 'verify' }
      }
    ])
    expect(reading.block).toMatchObject({ class: 'attention', code: 'verification-gate' })
  })

  it('reads a gate that stopped the run mid-plan as the SAME decision, from the same receipt', () => {
    const gate: SessionChainAgentStep = {
      id: 'verify',
      agent: 'claude',
      prompt: 'Verify',
      status: 'queued',
      verdict: { kind: 'verify', over: ['done'], consumed: 'gate' }
    }
    const publish: SessionChainAgentStep = {
      id: 'publish',
      agent: 'codex',
      prompt: 'Publish',
      status: 'queued'
    }
    const stopped = (status: string): SessionChain => {
      const chain = chainOf(
        outcomeOf([{ id: 'done', kind: 'report', target: 'verify' }], ['verify', 'publish']),
        [gate, publish],
        {},
        ['verify']
      )
      chain.verdicts = [
        {
          stepId: 'verify',
          attemptId: 'attempt_verify',
          verdict: { status, blockingFindings: ['the tax column is missing'] },
          consumptionKey: 'verdict:verify:attempt_verify',
          consumedAt: 1
        }
      ]
      return chain
    }
    const hold: SessionOutcomeHold = {
      kind: 'gate',
      stepId: 'verify',
      reason: 'The verification did not pass. the tax column is missing'
    }
    const midPlan = held(stopped('fail'), hold)
    expect(midPlan.block).toMatchObject({ class: 'attention', code: 'verification-gate' })
    expect(midPlan.run.phase).toBe('needs-you')
    // The id is the requirement's: the finished outcome's verification hold asks the same one.
    const finished = held(
      {
        ...stopped('fail'),
        outcomeSet: { ...stopped('fail').outcomeSet!, completedSteps: ['verify', 'publish'] }
      },
      { kind: 'verification', reason: 'The report names blocking findings.' }
    )
    expect(finished.run.attention.map((entry) => entry.id)).toEqual(
      midPlan.run.attention.map((entry) => entry.id)
    )
    // A gate that could not judge is an operational failure: nobody is asked anything.
    const unjudged = held(stopped('insufficient_evidence'), hold)
    expect(unjudged.block).toMatchObject({ class: 'failed', code: 'review-insufficient-evidence' })
    expect(unjudged.run).toMatchObject({ phase: 'failed', attention: [] })
  })

  it('does not ask again at the finish once the owner answered the stop', () => {
    const decision = { reason: 'human_decision' as const, since: 1, ref: 'verify' }
    const gate: SessionChainAgentStep = {
      id: 'verify',
      agent: 'claude',
      prompt: 'Verify',
      status: 'queued',
      verdict: { kind: 'verify', over: ['done'], consumed: 'gate' },
      wait: decision
    }
    const fix: SessionChainAgentStep = {
      id: 'fix',
      agent: 'codex',
      prompt: 'Fix',
      status: 'queued'
    }
    const finished = (steps: SessionChainAgentStep[]): SessionChain => {
      const chain = chainOf(
        outcomeOf(
          [{ id: 'done', kind: 'report', target: 'verify' }],
          steps.map((step) => step.id)
        ),
        steps
      )
      chain.verdicts = [
        {
          stepId: 'verify',
          attemptId: 'attempt_verify',
          verdict: { status: 'fail', blockingFindings: ['the tax column is missing'] },
          consumptionKey: 'verdict:verify:attempt_verify',
          consumedAt: 1
        }
      ]
      return chain
    }
    const verification: SessionOutcomeHold = {
      kind: 'verification',
      reason: 'The report names blocking findings.'
    }
    // Answered with a stage the stop never marked: that stage ran, the gate never passed.
    const answered = held(finished([gate, fix]), verification)
    expect(answered.block).toMatchObject({ class: 'failed', code: 'verification-gate' })
    expect(answered.set.attention ?? []).toEqual([])
    expect(answered.run).toMatchObject({ phase: 'failed', attention: [] })
    // A gate at the end of the plan stopped nothing behind it: its decision is still to be made.
    const last = held(finished([gate]), verification)
    expect(last.block).toMatchObject({ class: 'attention', code: 'verification-gate' })
    expect(last.run.phase).toBe('needs-you')
  })

  it('never writes onto a sealed run', () => {
    const chain = chainOf(outcomeOf([{ id: 'file', kind: 'file', target: '/workspace/out.txt' }]))
    const sealed: SessionOutcomeSet = {
      ...chain.outcomeSet!,
      completion: { at: 5, outcomes: [{ id: 'outcome', revision: 1 }], evidenceIds: [] }
    }
    expect(
      holdSessionOutcome(
        chain,
        sealed,
        'outcome',
        {
          kind: 'verification',
          reason: 'The execution host cannot read the expected delivered file.'
        },
        NOW
      )
    ).toBe(sealed)
  })
})
