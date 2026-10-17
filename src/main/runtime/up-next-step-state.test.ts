/**
 * A Verify that said no reads as STOPPED, not as done — and a stop says WHY by class.
 *
 * The settlement path is the trap this pins: a gate seat that returns `fail` finishes its
 * attempt (`completed`) and is marked in `completedSteps` before the outcome is blocked
 * (`session-outcome-verdict.ts`), so settlement alone would call the stage done and the
 * blocked stage would never reach the Now row (v3 amendments 1 and 7). The evidence that
 * survives is the receipt the gate spent plus the outcome it blocked, and that is what the
 * stage reading has to consult first. A gate that DID route its failure is not a stop: the
 * run continues at the repair and the outcome stays pending.
 *
 * What KIND of stop it is comes from the block its writer classified and from the open requests
 * (`docs/reference/session-run-lifecycle.md`): recovering, waiting, needs-you or failed. The
 * reason text is a diagnostic and decides nothing, so a block nobody classified is an honest
 * failure — never "needs you".
 */
import { describe, expect, it } from 'vitest'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../shared/session-human-attention'
import {
  SESSION_RECOVERING_MAX_MS,
  type SessionOutcomeBlock
} from '../../shared/session-outcome-block'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { UP_NEXT_BLOCK_ID } from '../../shared/up-next-types'
import { projectUpNext } from './up-next-projection'
import { upNextStepReading } from './up-next-step-state'

const NOW = 1_700_000_000_000

const seat = (over: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep =>
  ({
    id: 'v1',
    agent: 'claude',
    prompt: 'Check every Done When.',
    presetId: 'verify',
    status: 'queued',
    verdict: { kind: 'verify', consumed: 'gate', over: ['c1'] },
    ...over
  }) as SessionChainAgentStep

const attempt = (over: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt =>
  ({
    id: 'a1',
    outcomeId: 'o1',
    actionId: sessionOutcomeStepActionId('v1'),
    actionKey: 'k1',
    outcomeRevision: 1,
    state: 'completed',
    startedAt: NOW - 60_000,
    updatedAt: NOW - 10_000,
    ...over
  }) as SessionOutcomeAttempt

type World = {
  steps?: SessionChainAgentStep[]
  attempts?: SessionOutcomeAttempt[]
  completedSteps?: string[]
  verdicts?: SessionChain['verdicts']
  outcomeStatus?: 'pending' | 'running' | 'blocked'
  blockedReason?: string
  /** The class the writer gave the block; absent is a legacy block nobody classified. */
  block?: SessionOutcomeBlock
  attention?: HumanAttentionRequest[]
  /** Other tracks on the same host, before and after this stage's own outcome. */
  before?: SessionOutcome[]
  after?: SessionOutcome[]
}

/** A second track on the same host: "A blocked outcome does not block its siblings." */
const sibling = (id: string, reason: string): SessionOutcome =>
  ({
    id,
    title: 'Another track',
    finish: 'my-review',
    dependsOn: [],
    conditions: [{ id: `${id}-c`, kind: 'report', target: id }],
    actions: [],
    revision: 1,
    status: 'blocked',
    blockedReason: reason,
    evidence: []
  }) as unknown as SessionOutcome

function chainOf(world: World = {}): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: world.steps ?? [seat()],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: NOW - 10_000,
    ...(world.verdicts ? { verdicts: world.verdicts } : {}),
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      outcomes: [
        ...(world.before ?? []),
        {
          id: 'o1',
          title: 'It passes',
          finish: 'my-review',
          dependsOn: [],
          conditions: [{ id: 'c1', kind: 'report', target: 'o1' }],
          actions: [],
          revision: 1,
          status: world.outcomeStatus ?? 'pending',
          ...(world.blockedReason ? { blockedReason: world.blockedReason } : {}),
          ...(world.block ? { block: world.block } : {}),
          evidence: []
        },
        ...(world.after ?? [])
      ],
      removals: [],
      attempts: world.attempts ?? [attempt()],
      ...(world.attention ? { attention: world.attention } : {}),
      ...(world.completedSteps ? { completedSteps: world.completedSteps } : {}),
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: NOW - 10_000
    }
  } as unknown as SessionChain
}

/** A gate that decided, was marked complete, and then blocked the outcome. */
const settledVerdict = (status: string, reason: string): World => ({
  completedSteps: ['v1'],
  verdicts: [
    {
      stepId: 'v1',
      attemptId: 'a1',
      verdict: { kind: 'verify', status },
      consumptionKey: 'verdict:v1:a1',
      consumedAt: NOW - 10_000
    }
  ] as unknown as SessionChain['verdicts'],
  outcomeStatus: 'blocked',
  blockedReason: reason
})

describe('a Verify that did not pass', () => {
  it.each([
    ['fail', 'The candidate did not pass this gate.'],
    ['insufficient_evidence', 'The verifier could not judge on the evidence it was given.']
  ])('reads as stopped on %s, not done', (status, reason) => {
    const chain = chainOf(settledVerdict(status, reason))
    const reading = upNextStepReading(chain, [seat()], NOW)
    // No writer classified this block, so it is an honest failure and never "needs you".
    expect(reading.state).toBe('failed')
    expect(reading.locked).toBe(true)
    // The diagnostic travels with the stop for Details; the seat carries no error of its own.
    expect(reading.progress?.blockedReason).toBe(reason)
    expect(reading.progress?.stopCode).toBe('unclassified')
    expect(reading.progress?.stoppedAt).toBe(NOW - 10_000)
  })

  it('reads as stopped when the envelope was refused and the step was failed', () => {
    // `refuse()` sets the step status and blocks the outcome; the attempt still settled.
    const chain = chainOf({
      steps: [seat({ status: 'failed' })],
      outcomeStatus: 'blocked',
      blockedReason: 'This verdict seat returned no verdict line the host can read.'
    })
    expect(upNextStepReading(chain, [seat({ status: 'failed' })], NOW).state).toBe('failed')
  })

  it('still reads as done when the gate passed', () => {
    const chain = chainOf({
      completedSteps: ['v1'],
      verdicts: [
        {
          stepId: 'v1',
          attemptId: 'a1',
          verdict: { kind: 'verify', status: 'pass' },
          consumptionKey: 'verdict:v1:a1',
          consumedAt: NOW
        }
      ] as unknown as SessionChain['verdicts']
    })
    expect(upNextStepReading(chain, [seat()], NOW).state).toBe('done')
  })

  it('reads as done when a failed gate routed to a repair instead of stopping', () => {
    // A routed failure leaves the outcome pending: the run continues at the repair, so
    // this stage is finished and must not claim the conversation needs the person.
    const chain = chainOf({ ...settledVerdict('fail', ''), outcomeStatus: 'pending' })
    expect(upNextStepReading(chain, [seat()], NOW).state).toBe('done')
  })

  it('reports the stopped stage as the Now row of the projection', () => {
    const chain = {
      ...chainOf(settledVerdict('fail', 'The candidate did not pass this gate.')),
      steps: [
        seat({ id: 's1', presetId: 'implement', prompt: 'Build it.', status: 'launched' }),
        seat()
      ]
    } as SessionChain
    const view = projectUpNext({
      conversationId: { kind: 'pty', worktreeId: 'wt', paneKey: 'tab-1:leaf-1' },
      rowKey: 'r',
      chain: { ...chain, outcomeSet: { ...chain.outcomeSet!, completedSteps: ['s1', 'v1'] } },
      queue: null,
      drafts: [],
      busy: false,
      now: NOW
    })
    expect(view.header).toEqual({
      state: 'failed',
      stage: { n: 2, of: 2 },
      failure: { code: 'unclassified', reason: 'The candidate did not pass this gate.' }
    })
    expect(view.now).toEqual({ kind: 'stage', blockId: `${UP_NEXT_BLOCK_ID.planNode}v1` })
  })
})

describe('what the stage reading refuses to invent', () => {
  it('reads a stage with no seats as queued rather than as a finished one', () => {
    // Unreachable from `up-next-blocks.ts` — a stage always includes its head step — but
    // `seats.every` is vacuously true, so the fail-open direction is stated here.
    const reading = upNextStepReading(chainOf(), [], NOW)
    expect(reading).toEqual({ state: 'queued', locked: false })
  })

  it('shows a retryable seat as queued, the way the stage and the plan report do', () => {
    // The engine relaunches a retryable attempt itself, so nothing may tell the person it
    // failed or lock the stage they are still allowed to edit. Nothing is RUNNING either —
    // the tick skips it and the plan report calls it queued — so the seat row said the one
    // word the aggregate beside it contradicted.
    const chain = chainOf({ attempts: [attempt({ state: 'retryable' })] })
    const reading = upNextStepReading(chain, [seat()], NOW)
    expect(reading.state).toBe('queued')
    expect(reading.locked).toBe(false)
    expect(reading.progress?.seats).toEqual([{ id: 'v1', state: 'queued' }])
  })
})

/**
 * A stop is read from the track THIS stage is on, and from no other.
 *
 * A host runs many outcomes at once and "a blocked outcome does not block its siblings"
 * (`session-outcome-steps.ts`), so the stage's own outcome — the one its attempt names, or
 * the one whose `stepIds` hold its seats — is the only one that may stop it or say why.
 */
describe('whose stop it is', () => {
  it('stays done when a SIBLING outcome is blocked and its own routed and stayed pending', () => {
    const chain = chainOf({
      ...settledVerdict('fail', ''),
      outcomeStatus: 'pending',
      after: [sibling('o2', 'A different gate stopped this outcome.')]
    })
    const reading = upNextStepReading(chain, [seat()], NOW)
    // Done, and locked as any finished stage is — but not STOPPED, and with no reason
    // borrowed from the track next to it.
    expect(reading.state).toBe('done')
    expect(reading.progress?.blockedReason).toBeUndefined()
    expect(reading.progress?.stoppedAt).toBeUndefined()
  })

  it('reads the reason from its OWN outcome, not the first blocked one in the set', () => {
    const chain = chainOf({
      ...settledVerdict('fail', 'The candidate did not pass this gate.'),
      before: [sibling('o0', 'Unrelated earlier stop.')]
    })
    const reading = upNextStepReading(chain, [seat()], NOW)
    expect(reading.state).toBe('failed')
    expect(reading.progress?.blockedReason).toBe('The candidate did not pass this gate.')
  })

  it('resolves its own outcome by stepIds when no attempt names one', () => {
    // A legacy chain whose attempt was superseded: the outcome still says which steps are
    // its own, and that is enough to know which stop belongs to this stage.
    const chain = chainOf({
      ...settledVerdict('fail', 'The candidate did not pass this gate.'),
      attempts: [],
      before: [sibling('o0', 'Unrelated earlier stop.')]
    })
    const own = chain.outcomeSet!.outcomes.find((outcome) => outcome.id === 'o1')!
    ;(own as { stepIds?: string[] }).stepIds = ['v1']
    const reading = upNextStepReading(chain, [seat()], NOW)
    expect(reading.state).toBe('failed')
    // With no attempt to time it from, the stop still carries its reason and a stop time.
    expect(reading.progress?.blockedReason).toBe('The candidate did not pass this gate.')
    expect(reading.progress?.stoppedAt).toBe(NOW - 10_000)
  })

  it('does not claim the stage that ROUTED stopped a track a later gate blocked', () => {
    // Same outcome, blocked further along: this gate failed and routed to its repair, so the
    // stop belongs to the seat that had nowhere to route — naming this one would put the
    // wrong stage in the Now row.
    const routed = seat({ onFail: 'repair-1' } as Partial<SessionChainAgentStep>)
    const chain = {
      ...chainOf({ ...settledVerdict('fail', 'A later gate stopped this.'), steps: [routed] })
    } as SessionChain
    const reading = upNextStepReading(chain, [routed], NOW)
    expect(reading.state).toBe('done')
    expect(reading.progress?.stoppedAt).toBeUndefined()
  })
})

/**
 * The class of a stop. The 180 s stall sentence below is the evidence this pins: it used to reach
 * the person as "needs you" because ANY blocked outcome with a reason did. Now the same sentence
 * rides along as a diagnostic while the block's class — and only an open request — decides.
 */
describe('why a stopped stage cannot continue', () => {
  const STALL =
    "No activity was observed for 180s after this step's instruction was accepted, so the step is not running."
  const stalled = (block?: SessionOutcomeBlock, over: World = {}): World => ({
    attempts: [attempt({ state: 'blocked', error: STALL })],
    outcomeStatus: 'blocked',
    blockedReason: STALL,
    ...(block ? { block } : {}),
    ...over
  })
  const request = (over: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest => ({
    id: 'att_1',
    kind: 'clarification',
    scope: { outcomeId: 'o1', outcomeRevision: 1 },
    ask: 'Answer Claude Code’s question: Which price list is current?',
    why: 'Claude Code cannot choose this for you and is waiting for your answer.',
    recipient: { type: 'owner' },
    action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-9:leaf-1' },
    source: { type: 'agent-prompt', ref: 'Which price list is current?' },
    state: 'open',
    openedAt: NOW - 5_000,
    ...over
  })

  it('reads a stall the host will retry as recovering, with the sentence as a diagnostic', () => {
    const block: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW - 20_000,
      until: NOW + 15_000
    }
    const reading = upNextStepReading(chainOf(stalled(block)), [seat()], NOW)
    expect(reading.state).toBe('recovering')
    expect(reading.locked).toBe(true)
    expect(reading.progress?.blockedReason).toBe(STALL)
    expect(reading.progress?.stopCode).toBe('worker-stalled')
    expect(reading.progress?.seats).toEqual([{ id: 'v1', state: 'failed' }])
  })

  it('reads exhausted recovery as failed, and a legacy unclassified block the same way', () => {
    const failed: SessionOutcomeBlock = { class: 'failed', code: 'worker-stalled', since: NOW }
    expect(upNextStepReading(chainOf(stalled(failed)), [seat()], NOW).state).toBe('failed')
    const legacy = upNextStepReading(chainOf(stalled()), [seat()], NOW)
    expect(legacy.state).toBe('failed')
    expect(legacy.progress?.stopCode).toBe('unclassified')
  })

  it('escalates a recovering block nothing cleared in time to failed', () => {
    const stale: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW - SESSION_RECOVERING_MAX_MS - 1
    }
    expect(upNextStepReading(chainOf(stalled(stale)), [seat()], NOW).state).toBe('failed')
  })

  it('reads a registered wake as waiting — locked, and marked as a stop', () => {
    const block: SessionOutcomeBlock = {
      class: 'waiting',
      code: 'awaiting-evidence',
      since: NOW,
      wake: 'evidence'
    }
    const reading = upNextStepReading(chainOf(stalled(block)), [seat()], NOW)
    expect(reading.state).toBe('waiting')
    expect(reading.locked).toBe(true)
    expect(reading.progress?.stoppedAt).toBe(NOW - 10_000)
  })

  it('reads needs-you ONLY from an open request addressed to the owner', () => {
    const block: SessionOutcomeBlock = {
      class: 'attention',
      code: 'provider-authentication',
      since: NOW,
      attentionIds: ['att_1']
    }
    const asked = chainOf(stalled(block, { attention: [request()] }))
    expect(upNextStepReading(asked, [seat()], NOW).state).toBe('needs-you')
    // Someone else's reply is a wait, never the owner's needs-you.
    const others = chainOf(
      stalled(block, {
        attention: [request({ recipient: { type: 'person', employeeId: 'emp_1', name: 'Sal' } })]
      })
    )
    expect(upNextStepReading(others, [seat()], NOW).state).toBe('waiting')
    // A settled request asks nobody: the host re-derives the block on its next pass.
    const settled = chainOf(
      stalled(block, { attention: [request({ state: 'resolved', resolvedAt: NOW })] })
    )
    expect(upNextStepReading(settled, [seat()], NOW).state).toBe('recovering')
  })

  it('reads a stopped attempt the host has not classified yet as recovering', () => {
    const chain = chainOf({ attempts: [attempt({ state: 'blocked', error: STALL })] })
    const reading = upNextStepReading(chain, [seat()], NOW)
    expect(reading.state).toBe('recovering')
    expect(reading.progress?.blockedReason).toBe(STALL)
  })

  it('reads a LIVE agent asking its person something as needs-you, not as a stop', () => {
    const chain = chainOf({
      attempts: [attempt({ state: 'running' })],
      outcomeStatus: 'running',
      attention: [request({ scope: { outcomeId: 'o1', outcomeRevision: 1, attemptId: 'a1' } })]
    })
    const reading = upNextStepReading(chain, [seat()], NOW)
    expect(reading.state).toBe('needs-you')
    expect(reading.locked).toBe(true)
    expect(reading.progress?.stoppedAt).toBeUndefined()
    expect(reading.progress?.blockedReason).toBeUndefined()
  })

  it('ignores a request about an attempt that is no longer the current one', () => {
    const chain = chainOf({
      attempts: [attempt({ state: 'running' })],
      outcomeStatus: 'running',
      attention: [request({ scope: { outcomeId: 'o1', outcomeRevision: 1, attemptId: 'gone' } })]
    })
    expect(upNextStepReading(chain, [seat()], NOW).state).toBe('running')
  })
})
