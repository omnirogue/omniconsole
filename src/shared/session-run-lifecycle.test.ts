import { describe, expect, it } from 'vitest'
import { agentPromptAttention, personReviewAttention } from './session-attention-drafts'
import { openHumanAttention, resolveHumanAttention } from './session-human-attention'
import {
  SESSION_RECOVERING_MAX_MS,
  UNCLASSIFIED_BLOCK_CODE,
  type SessionOutcomeBlock
} from './session-outcome-block'
import type { SessionOutcomeSet } from './session-outcome-types'
import { sealSessionRunCompletion } from './session-run-completion'
import {
  SESSION_RUN_PHASES,
  UNVERIFIABLE_HOST_REASON,
  isSettledSessionRun,
  readSessionRun
} from './session-run-lifecycle'
import {
  blockRunOutcome,
  proveRun,
  runAttempt,
  runDefinition,
  runScope,
  runSet
} from './session-run-lifecycle.test-fixture'

const NOW = 10_000_000
const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'
const failedBlock = (code = 'worker-stalled'): SessionOutcomeBlock => ({
  class: 'failed',
  code,
  since: NOW
})

/** A running attempt whose agent asked its person a question, and the request that came of it. */
function asked(extraScope: Parameters<typeof runScope>[0] = {}): {
  set: SessionOutcomeSet
  id: string
} {
  const opened = openHumanAttention(
    { ...runSet(), attempts: [runAttempt()] },
    agentPromptAttention({
      scope: runScope({ attemptId: 'att_1', ...extraScope }),
      kind: 'clarification',
      agent: 'Claude',
      prompt: 'Which offer should the page lead with?',
      paneKey: 'tab-1:leaf-1'
    }),
    NOW
  )
  return {
    id: opened.id,
    set: blockRunOutcome(opened.set, 'one', 'Claude is asking a question.', {
      class: 'attention',
      code: 'agent-question',
      since: NOW,
      attentionIds: [opened.id]
    })
  }
}

function awaitingPerson(name?: string): SessionOutcomeSet {
  const opened = openHumanAttention(
    runSet(),
    personReviewAttention({
      scope: { outcomeId: 'one', outcomeRevision: 1, conditionId: 'file' },
      title: 'The report',
      employeeId: 'emp_gamma',
      ...(name ? { name } : {})
    }),
    NOW
  )
  return blockRunOutcome(opened.set, 'one', 'Waiting for the review reply.', {
    class: 'attention',
    code: 'person-review',
    since: NOW,
    attentionIds: [opened.id]
  })
}

describe('operational failures are never needs-you', () => {
  it.each([
    ['worker-stalled', STALL],
    ['startup-blocked', 'Agent startup blocked: codex-hooks-review-prompt'],
    ['reviewer-verdict-missing', 'A selected reviewer did not return a valid verdict.']
  ])('reads a %s block with a reason and no request as failed', (code, reason) => {
    const run = readSessionRun(blockRunOutcome(runSet(), 'one', reason, failedBlock(code)), {
      now: NOW
    })
    expect(run.phase).toBe('failed')
    expect(run.lifecycle).toBe('waiting')
    expect(run.attention).toEqual([])
    expect(run.awaitingOthers).toEqual([])
    // The reason is still there to read under Details; it just decides nothing.
    expect(run.reasons).toEqual([`one: ${reason}`])
    expect(run.failure).toEqual({ outcomeId: 'one', code, reason })
  })

  it('reads a legacy blocked outcome no writer classified as failed and unclassified', () => {
    const run = readSessionRun(blockRunOutcome(runSet(), 'one', STALL), { now: NOW })
    expect(run.phase).toBe('failed')
    expect(run.lifecycle).toBe('waiting')
    expect(run.attention).toEqual([])
    expect(run.failure).toEqual({ outcomeId: 'one', code: UNCLASSIFIED_BLOCK_CODE, reason: STALL })
  })

  it('names the phases it can return, and which of them are settled', () => {
    expect(SESSION_RUN_PHASES).toEqual([
      'active',
      'recovering',
      'waiting',
      'needs-you',
      'failed',
      'completed'
    ])
    expect(SESSION_RUN_PHASES.filter((phase) => isSettledSessionRun({ phase }))).toEqual([
      'failed',
      'completed'
    ])
  })
})

describe('recovering and waiting blocks', () => {
  const recovering = (extra: Partial<SessionOutcomeBlock>): SessionOutcomeBlock => ({
    class: 'recovering',
    code: 'worker-stalled',
    since: NOW,
    ...extra
  })

  it('reads a recovering block with a future action time as recovering until then', () => {
    const run = readSessionRun(
      blockRunOutcome(
        runSet(),
        'one',
        STALL,
        recovering({ since: NOW - 5_000, until: NOW + 15_000 })
      ),
      { now: NOW }
    )
    expect(run.phase).toBe('recovering')
    expect(run.lifecycle).toBe('waiting')
    expect(run.recoveringUntil).toBe(NOW + 15_000)
    expect(run.failure).toBeUndefined()
    expect(run.attention).toEqual([])
  })

  it('reports the earliest action time of several recovering outcomes', () => {
    const set = blockRunOutcome(
      blockRunOutcome(
        runSet([runDefinition('one'), runDefinition('two')]),
        'one',
        STALL,
        recovering({ until: NOW + 60_000 })
      ),
      'two',
      STALL,
      recovering({ until: NOW + 15_000 })
    )
    expect(readSessionRun(set, { now: NOW }).recoveringUntil).toBe(NOW + 15_000)
  })

  it('escalates a recovering block nothing cleared to failed, keeping its code', () => {
    const at = (block: SessionOutcomeBlock) =>
      readSessionRun(blockRunOutcome(runSet(), 'one', STALL, block), { now: NOW })
    expect(at(recovering({ since: NOW - SESSION_RECOVERING_MAX_MS })).phase).toBe('recovering')
    const stale = at(recovering({ since: NOW - SESSION_RECOVERING_MAX_MS - 1 }))
    expect(stale.phase).toBe('failed')
    expect(stale.lifecycle).toBe('waiting')
    expect(stale.failure).toEqual({ outcomeId: 'one', code: 'worker-stalled', reason: STALL })
    // Staleness runs from the scheduled action: a long backoff that only just came due is not stale.
    const due = at(recovering({ since: NOW - 10 * SESSION_RECOVERING_MAX_MS, until: NOW - 1_000 }))
    expect(due.phase).toBe('recovering')
    expect(due.recoveringUntil).toBe(NOW - 1_000)
    expect(
      at(
        recovering({
          since: NOW - 10 * SESSION_RECOVERING_MAX_MS,
          until: NOW - SESSION_RECOVERING_MAX_MS - 1
        })
      ).phase
    ).toBe('failed')
  })

  it('reads a waiting block as waiting on its named wake, however old it is', () => {
    const waiting = (wake?: string): SessionOutcomeBlock => ({
      class: 'waiting',
      code: 'evidence-poll',
      since: NOW - 100 * SESSION_RECOVERING_MAX_MS,
      ...(wake ? { wake } : {})
    })
    const named = readSessionRun(
      blockRunOutcome(runSet(), 'one', 'Waiting for the merge.', waiting('pull request merge')),
      { now: NOW }
    )
    expect(named.phase).toBe('waiting')
    expect(named.lifecycle).toBe('waiting')
    expect(named.wake).toBe('pull request merge')
    expect(named.attention).toEqual([])
    expect(
      readSessionRun(blockRunOutcome(runSet(), 'one', 'Waiting.', waiting()), { now: NOW }).wake
    ).toBe('evidence')
  })

  it('evaluates recovering before waiting, and waiting before failed', () => {
    const two = runSet([runDefinition('one'), runDefinition('two')])
    const failedTwo = blockRunOutcome(two, 'two', STALL, failedBlock())
    expect(
      readSessionRun(blockRunOutcome(failedTwo, 'one', STALL, recovering({ until: NOW + 1 })), {
        now: NOW
      }).phase
    ).toBe('recovering')
    expect(
      readSessionRun(
        blockRunOutcome(failedTwo, 'one', 'Waiting.', {
          class: 'waiting',
          code: 'evidence-poll',
          since: NOW
        }),
        { now: NOW }
      ).phase
    ).toBe('waiting')
  })
})

describe('needs-you comes only from a valid open request to the owner', () => {
  it('reads a request to the owner as needs-you, with what to provide, why, and where', () => {
    const run = readSessionRun(asked().set, { now: NOW })
    expect(run.phase).toBe('needs-you')
    expect(run.lifecycle).toBe('needs-you')
    expect(run.awaitingOthers).toEqual([])
    expect(run.attention).toHaveLength(1)
    expect(run.attention[0]).toMatchObject({
      kind: 'clarification',
      state: 'open',
      recipient: { type: 'owner' },
      ask: "Answer Claude's question: Which offer should the page lead with?",
      why: 'Claude cannot choose this for you and is waiting for your answer.',
      action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-1:leaf-1' }
    })
  })

  it('needs no blocked outcome: the request alone decides, even beside running work', () => {
    const { set } = asked()
    const running: SessionOutcomeSet = {
      ...set,
      outcomes: set.outcomes.map((outcome) => {
        const { block: _block, blockedReason: _reason, ...rest } = outcome
        return { ...rest, status: 'running' as const }
      })
    }
    expect(readSessionRun(running, { now: NOW }).phase).toBe('needs-you')
  })

  it('reads recovering once the request is answered, and failed if the host never follows up', () => {
    const { set, id } = asked()
    const answered = resolveHumanAttention(set, id, 'Answered in the conversation.', NOW + 10)
    const soon = readSessionRun(answered, { now: NOW + 10 })
    expect(soon.phase).toBe('recovering')
    expect(soon.attention).toEqual([])
    expect(readSessionRun(answered, { now: NOW + 10 + SESSION_RECOVERING_MAX_MS }).phase).toBe(
      'recovering'
    )
    const abandoned = readSessionRun(answered, { now: NOW + 11 + SESSION_RECOVERING_MAX_MS })
    expect(abandoned.phase).toBe('failed')
    expect(abandoned.failure?.code).toBe('agent-question')
  })

  it("reads a request to another person as waiting on them, never the owner's needs-you", () => {
    const named = readSessionRun(awaitingPerson('Gamma'), { now: NOW })
    expect(named.phase).toBe('waiting')
    expect(named.lifecycle).toBe('waiting')
    expect(named.attention).toEqual([])
    expect(named.awaitingOthers).toHaveLength(1)
    expect(named.awaitingOthers[0]?.recipient).toEqual({
      type: 'person',
      employeeId: 'emp_gamma',
      name: 'Gamma'
    })
    expect(named.wake).toBe('Gamma')
    expect(readSessionRun(awaitingPerson(), { now: NOW }).wake).toBe('emp_gamma')
  })

  it('ignores a request that no longer describes the run', () => {
    const { set } = asked()
    const failed = (next: SessionOutcomeSet) => blockRunOutcome(next, 'one', STALL, failedBlock())
    // The outcome was edited: the request is about revision 1.
    const edited: SessionOutcomeSet = {
      ...set,
      outcomes: set.outcomes.map((outcome) => ({ ...outcome, revision: 2 }))
    }
    expect(readSessionRun(failed(edited), { now: NOW }).phase).toBe('failed')
    // The attempt that asked was settled or replaced.
    for (const state of ['completed', 'superseded', 'retryable'] as const) {
      const settled = failed({ ...set, attempts: [runAttempt({ state })] })
      expect(readSessionRun(settled, { now: NOW }).phase).toBe('failed')
      expect(readSessionRun(settled, { now: NOW }).attention).toEqual([])
    }
    // A newer plan version replaced the strategy the request belonged to.
    expect(readSessionRun(failed(set), { now: NOW, planVersion: 2 }).phase).toBe('failed')
    expect(readSessionRun(asked({ planVersion: 2 }).set, { now: NOW, planVersion: 2 }).phase).toBe(
      'needs-you'
    )
  })
})

describe('an unowned continuation', () => {
  it('reads as waiting on the execution host, not needs-you and not failed', () => {
    const set = blockRunOutcome(runSet(), 'one', STALL, failedBlock())
    const run = readSessionRun(
      { ...set, continuation: { ...set.continuation, state: 'unverifiable' } },
      { now: NOW }
    )
    expect(run.phase).toBe('waiting')
    expect(run.lifecycle).toBe('waiting')
    expect(run.wake).toBe('execution host')
    expect(run.attention).toEqual([])
    expect(run.reasons).toEqual([`one: ${STALL}`, UNVERIFIABLE_HOST_REASON])
  })

  it('does not assert an unsealed completion, and does not raise an alarm either', () => {
    const proven = proveRun(runSet([runDefinition('one'), runDefinition('two')]), 'one', 'two')
    expect(readSessionRun(proven, { now: NOW }).phase).toBe('completed')
    const run = readSessionRun(
      { ...proven, continuation: { ...proven.continuation, state: 'unverifiable' } },
      { now: NOW }
    )
    expect(run).toMatchObject({ phase: 'waiting', lifecycle: 'waiting', satisfied: 2, total: 2 })
  })
})

describe('a sealed completion is final', () => {
  const sealed = (): SessionOutcomeSet =>
    sealSessionRunCompletion(
      proveRun(runSet([runDefinition('one'), runDefinition('two')]), 'one', 'two'),
      { now: NOW, operationId: 'op_seal' }
    )
  const completed = { phase: 'completed', lifecycle: 'complete', satisfied: 2, total: 2 }

  it('stays completed when the continuation becomes unverifiable', () => {
    const set = sealed()
    const run = readSessionRun(
      { ...set, continuation: { ...set.continuation, state: 'unverifiable' } },
      { now: NOW + 1 }
    )
    expect(run).toMatchObject(completed)
    expect(run.reasons).toEqual([])
  })

  it('stays completed when its evidence is later removed', () => {
    const set = sealed()
    const drifted: SessionOutcomeSet = {
      ...set,
      outcomes: set.outcomes.map((outcome) => ({
        ...outcome,
        status: 'pending' as const,
        evidence: []
      }))
    }
    expect(readSessionRun(drifted, { now: NOW + 1 })).toMatchObject(completed)
  })

  it('stays completed when an attempt later reports an error', () => {
    const set = sealed()
    const late = blockRunOutcome(
      { ...set, attempts: [runAttempt({ state: 'blocked', error: STALL })] },
      'one',
      STALL
    )
    const run = readSessionRun(late, { now: NOW + 1 })
    expect(run).toMatchObject(completed)
    expect(run.reasons).toEqual([])
    expect(run.failure).toBeUndefined()
  })

  it('raises nothing for a request left open on it, and carries the seal and the disposition', () => {
    const set = sealed()
    const opened = openHumanAttention(
      set,
      agentPromptAttention({
        scope: runScope(),
        kind: 'permission',
        agent: 'Claude',
        prompt: 'Run the deploy script?'
      }),
      NOW + 1
    )
    const run = readSessionRun(opened.set, { now: NOW + 2 })
    expect(run).toMatchObject(completed)
    expect(run.attention).toEqual([])
    expect(run.completion).toEqual(set.completion)
    expect(run.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
    expect(isSettledSessionRun(run)).toBe(true)
  })
})

describe('what counts as progress', () => {
  const chainOf = (...extra: string[]): SessionOutcomeSet =>
    blockRunOutcome(
      runSet([
        runDefinition('one'),
        runDefinition('two', { dependsOn: ['one'] }),
        runDefinition('three', { dependsOn: ['two'] }),
        ...extra.map((id) => runDefinition(id))
      ]),
      'one',
      STALL,
      failedBlock()
    )

  it('does not read work pending behind a blocked dependency as active, at any depth', () => {
    const run = readSessionRun(chainOf(), { now: NOW })
    expect(run.phase).toBe('failed')
    expect(run.failure?.outcomeId).toBe('one')
  })

  it('reads independent pending work beside a failed outcome as active', () => {
    expect(readSessionRun(chainOf('four'), { now: NOW }).phase).toBe('active')
  })

  it('reads a freshly committed set, and a running outcome, as active', () => {
    expect(readSessionRun(runSet(), { now: NOW })).toMatchObject({
      phase: 'active',
      lifecycle: 'waiting',
      satisfied: 0,
      total: 1,
      reasons: []
    })
    const set = chainOf()
    const running: SessionOutcomeSet = {
      ...set,
      outcomes: set.outcomes.map((outcome) =>
        outcome.id === 'two' ? { ...outcome, status: 'running' as const } : outcome
      )
    }
    expect(readSessionRun(running, { now: NOW }).phase).toBe('active')
  })
})
