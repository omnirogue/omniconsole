import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { HumanAttentionDraft } from '../../shared/session-human-attention'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type {
  SessionOutcome,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'

// The hold seam is another package's to fill in; this suite is about what the recompute does with
// whatever it returns, so the reading is scripted here.
const hold = vi.hoisted(() => ({ reading: vi.fn() }))
vi.mock('./session-outcome-hold-block', () => ({ sessionOutcomeHoldBlock: hold.reading }))
// The source conversation's live state and the verifier are seams too: this suite scripts what
// they say and checks what the recompute asks of a person because of it.
const seams = vi.hoisted(() => ({ source: vi.fn(), verify: vi.fn() }))
vi.mock('./session-outcome-source', () => ({ observeSessionOutcomeSource: seams.source }))
vi.mock('./session-outcome-verification', () => ({
  verifySessionOutcomeProgress: seams.verify
}))

import { SESSION_OUTCOME_HANDOFF_SIGN_IN } from './session-outcome-handoff-recovery'
import { recomputeSessionOutcomeStatuses } from './session-outcome-status-recompute'

const NOW = 1_000_000

/** A worker whose dispatch row is settled failed: the proof that lets the ladder replace it. */
const settledDeadWorker = {
  getOrchestrationDb: () => ({
    getDispatchContextById: () => ({ task_id: 'task_1', assignee_pane_key: 'tab-9:pane-9' }),
    getWorkerDispatch: () => ({ state: 'failed' }),
    getTask: () => ({ status: 'failed' })
  })
} as unknown as OrcaRuntimeService

function attempt(overrides: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt {
  return {
    id: 'attempt_1',
    outcomeId: 'ship',
    actionId: 'step_seat',
    actionKey: 'seat',
    outcomeRevision: 1,
    state: 'blocked',
    launchDisposition: 'started',
    dispatchId: 'ctx_1',
    error: 'Agent process exited with code 1',
    failure: { code: 'worker-exited', at: NOW - 1_000 },
    startedAt: 1,
    updatedAt: NOW - 1_000,
    ...overrides
  }
}

function scenario(input: {
  attempts: SessionOutcomeAttempt[]
  outcome?: Partial<SessionOutcome>
  set?: Partial<SessionOutcomeSet>
  chain?: Partial<SessionChain>
}): { chain: SessionChain; set: SessionOutcomeSet } {
  const set = {
    revision: 1,
    outcomes: [
      {
        id: 'ship',
        title: 'Ship it',
        finish: 'complete',
        dependsOn: [],
        stepIds: ['seat'],
        conditions: [{ id: 'file', kind: 'file', target: '/workspace/out.txt' }],
        actions: [],
        revision: 1,
        status: 'pending',
        evidence: [],
        ...input.outcome
      }
    ],
    attempts: input.attempts,
    completedSteps: [],
    continuation: { sourceReady: false, state: 'owned' },
    ...input.set
  } as unknown as SessionOutcomeSet
  const chain = {
    id: 'chain',
    workspacePath: '/workspace',
    steps: [
      { id: 'seat', agent: 'codex', prompt: 'work', status: 'queued' } as SessionChainAgentStep
    ],
    ...input.chain,
    outcomeSet: set
  } as unknown as SessionChain
  return { chain, set }
}

const recompute = (
  input: Parameters<typeof scenario>[0],
  runtime = settledDeadWorker,
  now = NOW
): Promise<SessionOutcomeSet> => {
  const { chain, set } = scenario(input)
  return recomputeSessionOutcomeStatuses(runtime, chain, set, [], now)
}

beforeEach(() => {
  hold.reading.mockReset()
  seams.source.mockReset()
  seams.verify.mockReset()
  seams.source.mockResolvedValue({ ready: true, version: 'v1' })
  // A verifier with nothing to say: the set as it came, no reason to hold.
  seams.verify.mockImplementation(async (_runtime, chain) => ({ set: chain.outcomeSet }))
})

describe('a stopped attempt reads through the recovery ladder, never as needs-you', () => {
  it('is recovering until its backoff is due when the worker is provably dead', async () => {
    const set = await recompute({ attempts: [attempt()] })
    expect(set.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'Agent process exited with code 1',
      block: { class: 'recovering', code: 'worker-exited', since: NOW, until: NOW - 1_000 + 15_000 }
    })
    expect(set.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(set, { now: NOW })).toMatchObject({
      phase: 'recovering',
      lifecycle: 'waiting'
    })
  })

  it('keeps the moment a block began across passes, so its age is measurable', async () => {
    const first = await recompute({ attempts: [attempt()] })
    const { chain } = scenario({ attempts: [attempt()] })
    const second = await recomputeSessionOutcomeStatuses(
      settledDeadWorker,
      chain,
      first,
      [],
      NOW + 2_000
    )
    expect(second.outcomes[0]!.block).toMatchObject({ class: 'recovering', since: NOW })
  })

  it('fails honestly, with no request, once the bounded retries are spent', async () => {
    const spent = (id: string): SessionOutcomeAttempt =>
      attempt({ id, state: 'retryable', error: undefined })
    const set = await recompute({ attempts: [spent('attempt_a'), spent('attempt_b'), attempt()] })
    expect(set.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'failed', code: 'worker-exited' }
    })
    expect(set.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(set, { now: NOW }).phase).toBe('failed')
  })

  it('holds a worker it cannot prove stopped, then fails it — and never reads it as retryable', async () => {
    const lost = attempt({
      state: 'unverifiable',
      failure: undefined,
      error: 'Execution is unverifiable; the action will not be repeated.'
    })
    const held = await recompute({ attempts: [lost] }, {} as OrcaRuntimeService)
    expect(held.outcomes[0]!.block).toMatchObject({
      class: 'waiting',
      code: 'worker-unverifiable',
      wake: 'worker contact',
      until: NOW - 1_000 + 10 * 60_000
    })
    const failed = await recompute(
      { attempts: [lost] },
      {} as OrcaRuntimeService,
      NOW + 11 * 60_000
    )
    expect(failed.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'unverifiable-worker'
    })
    expect(failed.attention ?? []).toEqual([])
  })

  it('asks for a sign-in at once: no retry can meet that requirement', async () => {
    const set = await recompute({
      attempts: [attempt({ failure: { code: 'provider-authentication', at: NOW - 1_000 } })]
    })
    expect(set.attention).toHaveLength(1)
    expect(set.attention![0]).toMatchObject({
      kind: 'credential',
      state: 'open',
      recipient: { type: 'owner' },
      source: { type: 'provider-authentication' },
      scope: { outcomeId: 'ship', outcomeRevision: 1, stepId: 'seat', attemptId: 'attempt_1' },
      action: { kind: 'open-conversation', paneKey: 'tab-9:pane-9' }
    })
    expect(set.outcomes[0]!.block).toMatchObject({
      class: 'attention',
      code: 'provider-authentication',
      attentionIds: [set.attention![0]!.id]
    })
    expect(sessionOutcomeProgress(set, { now: NOW }).phase).toBe('needs-you')
  })
})

describe('a live agent asking its person something', () => {
  const asking = attempt({
    state: 'running',
    error: undefined,
    failure: undefined,
    awaiting: {
      kind: 'permission',
      prompt: 'Bash rm -rf build',
      since: NOW - 500,
      paneKey: 'tab-3:pane-3'
    }
  })

  it('is the request itself: what to answer, why, and the pane to answer it in', async () => {
    const set = await recompute({ attempts: [asking] })
    expect(set.attention).toHaveLength(1)
    const request = set.attention![0]!
    expect(request).toMatchObject({
      kind: 'permission',
      state: 'open',
      openedAt: NOW,
      recipient: { type: 'owner' },
      source: { type: 'agent-prompt' },
      action: { kind: 'open-conversation', paneKey: 'tab-3:pane-3' }
    })
    expect(request.ask).toContain('Bash rm -rf build')
    expect(request.why.length).toBeGreaterThan(0)
    expect(set.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'attention', code: 'agent-prompt', attentionIds: [request.id] }
    })
    expect(sessionOutcomeProgress(set, { now: NOW })).toMatchObject({
      phase: 'needs-you',
      attention: [{ id: request.id }]
    })
  })

  it('is one request however often it is re-observed', async () => {
    const first = await recompute({ attempts: [asking] })
    const { chain } = scenario({ attempts: [asking] })
    const again = await recomputeSessionOutcomeStatuses(
      settledDeadWorker,
      chain,
      first,
      [],
      NOW + 60_000
    )
    expect(again.attention).toHaveLength(1)
    expect(again.attention![0]).toMatchObject({ id: first.attention![0]!.id, openedAt: NOW })
  })

  it('resolves the request by itself when the agent stops asking, and the work just continues', async () => {
    const first = await recompute({ attempts: [asking] })
    const answered = { ...asking, awaiting: undefined }
    const { chain } = scenario({ attempts: [answered] })
    const after = await recomputeSessionOutcomeStatuses(
      settledDeadWorker,
      chain,
      { ...first, attempts: [answered] },
      [],
      NOW + 5_000
    )
    expect(after.attention![0]).toMatchObject({ state: 'resolved', resolvedAt: NOW + 5_000 })
    expect(after.outcomes[0]).toMatchObject({
      status: 'running',
      blockedReason: undefined,
      block: undefined
    })
    expect(sessionOutcomeProgress(after, { now: NOW + 5_000 }).phase).toBe('active')
  })
})

describe('what the recompute leaves alone', () => {
  it('returns a sealed set untouched: success is decided once', async () => {
    const { chain, set } = scenario({
      attempts: [attempt()],
      set: { completion: { at: 1, outcomes: [{ id: 'ship', revision: 1 }], evidenceIds: [] } }
    })
    expect(await recomputeSessionOutcomeStatuses(settledDeadWorker, chain, set, [], NOW)).toBe(set)
  })

  it('never rewrites a satisfied outcome', async () => {
    const set = await recompute({ attempts: [attempt()], outcome: { status: 'satisfied' } })
    expect(set.outcomes[0]).toMatchObject({ status: 'satisfied' })
    expect(set.outcomes[0]!.block).toBeUndefined()
  })

  it('leaves a continuation block in place and keeps the request that explains it', async () => {
    const request = {
      id: 'att_principal_ship_x',
      kind: 'credential',
      scope: { outcomeId: 'ship', outcomeRevision: 1 },
      ask: 'Sign back in as the company and person this work was started under.',
      why: 'The work is bound to that identity and may not continue under another one.',
      recipient: { type: 'owner' },
      source: { type: 'principal', ref: 'ship' },
      state: 'open',
      openedAt: 5
    }
    const block = {
      class: 'attention',
      code: 'principal-mismatch',
      since: 5,
      attentionIds: [request.id]
    }
    const set = await recompute({
      attempts: [],
      outcome: { status: 'blocked', blockedReason: 'Restore the signed person.', block } as never,
      set: { attention: [request] } as never
    })
    expect(set.outcomes[0]).toMatchObject({ status: 'blocked', block: { since: 5 } })
    expect(set.attention![0]).toMatchObject({ state: 'open' })
  })
})

describe('a hold that is not a stopped attempt', () => {
  const draft: HumanAttentionDraft = {
    kind: 'decision',
    scope: { outcomeId: 'ship', outcomeRevision: 1 },
    ask: 'Decide what happens to 2 open review findings.',
    why: 'All 1 authorized review round is used; another one needs your say.',
    recipient: { type: 'owner' },
    action: { kind: 'open-up-next', label: 'Decide' },
    source: { type: 'review-findings', ref: 'rounds:1' }
  }
  const reviewed = {
    attempts: [attempt({ state: 'completed', error: undefined, failure: undefined })],
    outcome: { blockedReason: 'Reviewers still report findings.' },
    chain: {
      steps: [
        {
          id: 'seat',
          agent: 'codex',
          prompt: 'review',
          status: 'queued',
          review: {
            groupId: 'critique',
            reviewerId: 'seat',
            round: 1,
            maxRounds: 1,
            candidateVersion: 'v1'
          }
        } as unknown as SessionChainAgentStep
      ],
      reviewLoop: { groups: [{ id: 'critique', status: 'blocked', rounds: [] }] }
    } as unknown as Partial<SessionChain>
  }

  it('takes its class from the hold seam and opens the requests the seam returns', async () => {
    hold.reading.mockReturnValue({
      block: { class: 'attention', code: 'review-findings' },
      attention: [draft]
    })
    const set = await recompute(reviewed)
    expect(hold.reading).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ship' }),
      { kind: 'review-round', groupId: 'critique', reason: 'Reviewers still report findings.' },
      NOW
    )
    expect(set.attention).toHaveLength(1)
    expect(set.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'Reviewers still report findings.',
      block: { class: 'attention', code: 'review-findings', attentionIds: [set.attention![0]!.id] }
    })
  })

  const unsigned: Parameters<typeof scenario>[0] = {
    attempts: [],
    outcome: { stepIds: ['handoff'] },
    chain: {
      steps: [
        {
          kind: 'handoff',
          id: 'handoff',
          status: 'queued',
          handoff: { recipients: [], deliverables: { kind: 'files', paths: [] } }
        }
      ]
    } as unknown as Partial<SessionChain>
  }

  it.each<[string, Parameters<typeof scenario>[0], Record<string, string>]>([
    ['a stopped review round', reviewed, { kind: 'review-round', groupId: 'critique' }],
    [
      'a handoff this host cannot send until someone signs in',
      unsigned,
      { kind: 'handoff', stepId: 'handoff', reason: SESSION_OUTCOME_HANDOFF_SIGN_IN }
    ]
  ])(
    're-derives %s on the next pass, so its request and its start both stand',
    async (_name, input, expected) => {
      hold.reading.mockReturnValue({
        block: { class: 'attention', code: 'held-for-test' },
        attention: [draft]
      })
      const first = await recompute(input)
      const { chain } = scenario(input)
      const second = await recomputeSessionOutcomeStatuses(
        settledDeadWorker,
        chain,
        first,
        [],
        NOW + 60_000
      )
      expect(hold.reading).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ id: 'ship' }),
        expect.objectContaining(expected),
        NOW + 60_000
      )
      expect(second.outcomes[0]).toMatchObject({
        status: 'blocked',
        block: { class: 'attention', code: 'held-for-test', since: NOW }
      })
      expect(second.attention).toMatchObject([{ state: 'open', openedAt: NOW }])
    }
  )

  it('reads a hold with a wake as waiting, and asks nobody', async () => {
    hold.reading.mockReturnValue({
      block: { class: 'waiting', code: 'review-round-hold', wake: 'reviewer' },
      attention: []
    })
    const set = await recompute(reviewed)
    expect(set.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(set, { now: NOW })).toMatchObject({
      phase: 'waiting',
      wake: 'reviewer'
    })
  })
})

describe('an outcome the source conversation itself finishes', () => {
  // No actions and no steps: the "result" is whatever the conversation the outcome belongs to
  // produces, so it exists only once that conversation is idle.
  const ownReview: HumanAttentionDraft = {
    kind: 'review',
    scope: { outcomeId: 'ship', outcomeRevision: 1, conditionId: 'my-review' },
    ask: 'Review the result of "Ship it" and approve it or send it back.',
    why: 'This outcome is finished only by your own review; nobody else can give it.',
    recipient: { type: 'owner' },
    action: { kind: 'review-outcome', label: 'Review', conditionId: 'my-review' },
    source: { type: 'review-condition', ref: 'v1' }
  }
  const conversationOwned: Parameters<typeof scenario>[0] = {
    attempts: [],
    outcome: {
      finish: 'my-review',
      stepIds: [],
      actions: [],
      conditions: [{ id: 'my-review', kind: 'review', target: 'ship' }]
    },
    set: {
      continuation: { sourceReady: true, sourceVersion: 'v1', state: 'owned' }
    } as unknown as Partial<SessionOutcomeSet>,
    chain: { steps: [] }
  }

  function verifierAsksForReview(): void {
    seams.verify.mockImplementation(async (_runtime, chain) => ({
      set: chain.outcomeSet,
      reason: 'Your review is required for this version.'
    }))
    hold.reading.mockReturnValue({
      block: { class: 'attention', code: 'own-review' },
      attention: [ownReview]
    })
  }

  it('asks for the review once the conversation is idle', async () => {
    verifierAsksForReview()
    const set = await recompute(conversationOwned)
    expect(set.outcomes[0]).toMatchObject({ status: 'blocked', block: { code: 'own-review' } })
    expect(set.attention?.map((entry) => entry.state)).toEqual(['open'])
  })

  it('does not ask while the conversation is still working, even though it was idle once', async () => {
    verifierAsksForReview()
    seams.source.mockResolvedValue({ ready: false, wait: 'the source turn to finish' })
    const set = await recompute(conversationOwned)
    // Verified all the same — a contrary reading must retire a stale receipt — but not held on.
    expect(seams.verify).toHaveBeenCalled()
    expect(set.outcomes[0]).toMatchObject({ status: 'pending', block: undefined })
    expect(set.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(set, { now: NOW }).phase).not.toBe('needs-you')
  })

  it('withdraws an open review ask when the person sends the agent back to work', async () => {
    verifierAsksForReview()
    const asked = await recompute(conversationOwned)
    expect(asked.attention?.[0]?.state).toBe('open')
    seams.source.mockResolvedValue({ ready: false, wait: 'the source turn to finish' })
    const { chain } = scenario({ ...conversationOwned, set: asked })
    const set = await recomputeSessionOutcomeStatuses(settledDeadWorker, chain, asked, [], NOW + 1)
    expect(set.outcomes[0]).toMatchObject({ status: 'pending' })
    expect(set.attention?.[0]?.state).not.toBe('open')
  })

  it('still asks when the source cannot be read at all: an unreadable pane is not a working one', async () => {
    verifierAsksForReview()
    seams.source.mockResolvedValue({ ready: false, unverifiable: true })
    const set = await recompute(conversationOwned)
    expect(set.outcomes[0]).toMatchObject({ status: 'blocked', block: { code: 'own-review' } })
  })
})
