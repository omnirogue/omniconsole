/**
 * A person review is a REPLY, not an approval.
 *
 * Every reply is recorded, with its decision in the receipt: the verifier used to accept only
 * `approve`, which left a `request_changes` reply recorded as no evidence at all — `replied`
 * stayed short of `total` and nobody could tell the reviewer had answered. What the run does next
 * reads the decision (owner's ruling, 2026-09-18): work held behind the review is released only
 * when every reviewer approved; a request for changes goes back to the agent and the reviewer is
 * asked again (`up-next-review-fix.ts`).
 *
 * The legacy recipient-less review condition is a different thing (the person's OWN review
 * of this version) and is decided elsewhere: no hub decision stands in for it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { HandoffDetail } from '../../shared/console-handoff-contract'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import {
  sessionOutcomeVerifiedEvidence,
  verifySessionOutcomeCondition
} from './session-outcome-evidence'
import {
  installSessionOutcomeHandoffReader,
  verifySessionOutcomeExternalCondition
} from './session-outcome-external-evidence'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import {
  upNextReviewAnswered,
  upNextReviewOpen,
  upNextReviewReplaced,
  upNextReviewReplies,
  upNextReviewSettled
} from './up-next-person-facts'

const sha = createHash('sha256').update('candidate bytes').digest('hex')

type Review = { id: string; decision: 'approve' | 'request_changes'; current: boolean }

const file = (over: Partial<HandoffDetail['files'][number]> = {}): HandoffDetail['files'][number] =>
  ({
    id: 'hfv_1',
    path: 'src/a.ts',
    name: 'a.ts',
    sha256: sha,
    size: 12,
    version: 1,
    parent_version_id: null,
    current: true,
    available: true,
    ...over
  }) as HandoffDetail['files'][number]

function detail(threadId: string, recipient: string, reviews: Review[]): HandoffDetail {
  return {
    thread: {
      id: threadId,
      board_task_id: null,
      author_employee_id: 'emp_sal',
      recipient_employee_id: recipient,
      title: 'Review the change',
      state: 'replied',
      action: null,
      due_at: null,
      parent_thread_id: null,
      delivery_id: 'del_1',
      updated: '2026-09-18T00:00:00Z'
    },
    files: [file()],
    reviews: reviews.map((review) => ({ ...review, version_ids: ['hfv_1'] })),
    entries: []
  } as unknown as HandoffDetail
}

/** One hub thread per reviewer, answered with whatever decision the test names. */
function hub(replies: Record<string, Review[]>): void {
  installSessionOutcomeHandoffReader(async ({ threadId }) => {
    const recipient = threadId === 'hth_a' ? 'emp_a' : 'emp_b'
    return { ok: true, data: detail(threadId, recipient, replies[threadId] ?? []) } as never
  })
}

const reviewCondition = (id: string, recipientId: string, threadId: string) =>
  ({
    id,
    kind: 'review',
    target: threadId,
    recipientId,
    fileVersions: [{ path: 'src/a.ts', sha256: sha }]
  }) as unknown as SessionOutcomeCondition

const conditions = [
  reviewCondition('c_a', 'emp_a', 'hth_a'),
  reviewCondition('c_b', 'emp_b', 'hth_b')
]

function chainOf(): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: [
      {
        id: 'h1',
        kind: 'handoff',
        status: 'delivered',
        handoff: {
          savedAt: 10,
          includeSummary: true,
          deliverables: { kind: 'files', paths: ['src/a.ts'] },
          disposition: 'feedback',
          recipients: [
            {
              employeeId: 'emp_a',
              name: 'Jordan Taylor',
              operationId: 'op_a',
              delivery: 'sent',
              threadId: 'hth_a',
              at: 20
            },
            {
              employeeId: 'emp_b',
              name: 'Iris Khan',
              operationId: 'op_b',
              delivery: 'sent',
              threadId: 'hth_b',
              at: 21
            }
          ]
        }
      }
    ],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 4,
      outcomes: [
        {
          id: 'o1',
          title: 'Both reviewers replied',
          finish: 'my-review',
          dependsOn: [],
          conditions,
          actions: [],
          revision: 2,
          status: 'pending',
          evidence: []
        }
      ],
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 3
    }
  } as unknown as SessionChain
}

beforeEach(() => {
  hub({})
})

describe('a named reviewer who replied', () => {
  it('returns the work on request_changes, with the decision in the receipt', async () => {
    hub({ hth_b: [{ id: 'rev_9', decision: 'request_changes', current: true }] })
    const result = await verifySessionOutcomeExternalCondition(
      conditions[1]!,
      undefined,
      chainOf(),
      'o1'
    )
    expect(result).toMatchObject({
      verified: true,
      receipt: 'handoff-review:hth_b:rev_9:request_changes'
    })
  })

  it('still returns the work on approve, with that decision in the receipt', async () => {
    hub({ hth_a: [{ id: 'rev_1', decision: 'approve', current: true }] })
    const result = await verifySessionOutcomeExternalCondition(
      conditions[0]!,
      undefined,
      chainOf(),
      'o1'
    )
    expect(result).toMatchObject({ verified: true, receipt: 'handoff-review:hth_a:rev_1:approve' })
  })

  it('takes the last current review the hub lists for them', async () => {
    hub({
      hth_b: [
        { id: 'rev_1', decision: 'request_changes', current: true },
        { id: 'rev_2', decision: 'approve', current: true }
      ]
    })
    await expect(
      verifySessionOutcomeExternalCondition(conditions[1]!, undefined, chainOf(), 'o1')
    ).resolves.toMatchObject({ receipt: 'handoff-review:hth_b:rev_2:approve' })
  })

  it('does not count a review of versions that are no longer current', async () => {
    hub({ hth_b: [{ id: 'rev_old', decision: 'request_changes', current: false }] })
    await expect(
      verifySessionOutcomeExternalCondition(conditions[1]!, undefined, chainOf(), 'o1')
    ).resolves.toEqual({
      verified: false,
      reason: 'The requested person has not returned a review of the current file versions.'
    })
  })
})

describe('the continuation gate behind a two-person review', () => {
  /** The receipt this verifier mints, recorded exactly as the verification loop records it. */
  async function record(chain: SessionChain, condition: SessionOutcomeCondition) {
    const result = await verifySessionOutcomeExternalCondition(condition, undefined, chain, 'o1')
    if (!result.verified) {
      throw new Error(result.reason)
    }
    const outcome = chain.outcomeSet!.outcomes[0]!
    return {
      ...chain,
      outcomeSet: recordSessionOutcomeEvidence(
        chain.outcomeSet!,
        sessionOutcomeVerifiedEvidence(outcome, condition, result.receipt, 100)
      )
    }
  }

  it('stays closed when both replied but one of them asked for changes', async () => {
    hub({
      hth_a: [{ id: 'rev_1', decision: 'approve', current: true }],
      hth_b: [{ id: 'rev_9', decision: 'request_changes', current: true }]
    })
    let chain = chainOf()
    expect(upNextReviewSettled(chain, 'h1')).toBe(false)
    chain = await record(chain, conditions[0]!)
    // One of two said OK: the held Improve stage still waits, and the panel says so.
    expect(upNextReviewReplies(chain, 'h1', 200)).toMatchObject({
      replied: 1,
      total: 2,
      approved: 1
    })
    expect(upNextReviewSettled(chain, 'h1')).toBe(false)
    chain = await record(chain, conditions[1]!)
    // Both answered, and "needs changes" is not an OK: nothing held behind the review runs.
    expect(upNextReviewReplies(chain, 'h1', 200)).toMatchObject({
      replied: 2,
      total: 2,
      approved: 1,
      answers: [
        { employeeId: 'emp_a', decision: 'approve' },
        { employeeId: 'emp_b', decision: 'request_changes' }
      ]
    })
    expect(upNextReviewAnswered(chain, 'h1')).toBe(true)
    expect(upNextReviewSettled(chain, 'h1')).toBe(false)
  })

  it('opens once every reviewer approved the current version', async () => {
    hub({
      hth_a: [{ id: 'rev_1', decision: 'approve', current: true }],
      hth_b: [{ id: 'rev_2', decision: 'approve', current: true }]
    })
    let chain = await record(chainOf(), conditions[0]!)
    expect(upNextReviewSettled(chain, 'h1')).toBe(false)
    chain = await record(chain, conditions[1]!)
    expect(upNextReviewReplies(chain, 'h1', 200)).toMatchObject({ approved: 2, total: 2 })
    expect(upNextReviewSettled(chain, 'h1')).toBe(true)
  })

  it('never counts a reply the run already fixed and asked again about', async () => {
    hub({ hth_b: [{ id: 'rev_9', decision: 'request_changes', current: true }] })
    const receipt = 'handoff-review:hth_b:rev_9:request_changes'
    const chain = chainOf()
    const spent: SessionChain = {
      ...chain,
      outcomeSet: {
        ...chain.outcomeSet!,
        heldContinuation: {
          reviewStepIds: ['h1'],
          fixes: [{ receipt, stepId: 'h1', employeeId: 'emp_b', round: 1, at: 50, reaskedAt: 60 }]
        }
      }
    }
    // The hub still lists the old reply as current: it is not an answer to the new round.
    await expect(
      verifySessionOutcomeExternalCondition(conditions[1]!, undefined, spent, 'o1')
    ).resolves.toMatchObject({ verified: false })
  })
})

describe('a round-2 reply on the same thread', () => {
  const transcript = createHash('sha256').update('conversation so far').digest('hex')

  /** Round 2 re-captured `a.ts` (too large for the return route) and the transcript, then asked again. */
  function reasked(plan: boolean): SessionChain {
    const chain = chainOf()
    const step = chain.steps[0]!
    if (step.kind !== 'handoff') {
      throw new Error('fixture')
    }
    return {
      ...chain,
      steps: [
        {
          ...step,
          handoff: {
            ...step.handoff,
            reask: true as const,
            files: [
              { name: 'a.ts', sha256: sha, size: 12, sourcePath: '/w/src/a.ts' },
              {
                name: 'Transcript-round2.md',
                sha256: transcript,
                size: 40,
                sourcePath: null,
                generatedKind: 'transcript' as const
              }
            ],
            recipients: step.handoff.recipients.map((person) => ({
              ...person,
              operationId: `${person.operationId}_round_2`,
              round: 2,
              ...(plan
                ? {
                    reaskPlan: {
                      operationId: `${person.operationId}_round_2`,
                      threadId: person.threadId!,
                      note: 'Updated after your notes (round 2).',
                      files: [{ index: 0, name: 'a (round 2).ts' }]
                    }
                  }
                : {})
            }))
          }
        }
      ]
    }
  }

  it('is held to what the re-ask sent: the renamed revision, and no new transcript', async () => {
    // The thread shows the revision under its round name; the round-1 transcript is still there.
    installSessionOutcomeHandoffReader(async ({ threadId }) => {
      const data = detail(threadId, 'emp_a', [{ id: 'rev_2', decision: 'approve', current: true }])
      return {
        ok: true,
        data: {
          ...data,
          files: [
            file({ id: 'hfv_1', name: 'a.ts', current: false }),
            file({ id: 'hfv_2', name: 'a (round 2).ts' }),
            file({ id: 'hfv_t', name: 'Transcript-round1.md', sha256: 'b'.repeat(64) })
          ],
          reviews: [
            { id: 'rev_2', decision: 'approve', current: true, version_ids: ['hfv_2', 'hfv_t'] }
          ]
        }
      } as never
    })
    const condition = { ...conditions[0]!, fileVersions: undefined } as SessionOutcomeCondition
    await expect(
      verifySessionOutcomeExternalCondition(condition, undefined, reasked(true), 'o1')
    ).resolves.toMatchObject({ verified: true, receipt: 'handoff-review:hth_a:rev_2:approve' })
    // Without the plan that says what was sent, every captured file must be on the thread as-is.
    await expect(
      verifySessionOutcomeExternalCondition(condition, undefined, reasked(false), 'o1')
    ).resolves.toEqual({
      verified: false,
      reason: 'The delivery receipt does not expose the requested current file bytes.'
    })
  })
})

describe('a second Review of the same person', () => {
  // The compiler's spelling: a named review condition targets the person, not a thread.
  const named = {
    id: 'c_a',
    kind: 'review',
    target: 'emp_a',
    recipientId: 'emp_a'
  } as SessionOutcomeCondition
  const firstAnswer = 'handoff-review:hth_a:rev_1:approve'

  /** emp_a's condition holds `answered`, if any; `h2` asks them again, delivered on `thread` or not yet. */
  function askedTwice(thread?: string, answered?: string): SessionChain {
    const chain = chainOf()
    const first = chain.steps[0]!
    if (first.kind !== 'handoff') {
      throw new Error('fixture')
    }
    const again = {
      ...first,
      id: 'h2',
      status: thread ? ('delivered' as const) : ('queued' as const),
      handoff: {
        ...first.handoff,
        savedAt: 20,
        recipients: [
          {
            employeeId: 'emp_a',
            name: 'Jordan Taylor',
            operationId: 'op_a_2',
            delivery: thread ? ('sent' as const) : ('pending' as const),
            ...(thread ? { threadId: thread, at: 30 } : {})
          }
        ]
      }
    }
    const outcome = {
      ...chain.outcomeSet!.outcomes[0]!,
      conditions: [named],
      stepIds: ['h1', 'h2']
    }
    const set = { ...chain.outcomeSet!, outcomes: [outcome] }
    return {
      ...chain,
      steps: [first, again],
      outcomeSet: answered
        ? recordSessionOutcomeEvidence(
            set,
            sessionOutcomeVerifiedEvidence(outcome, named, answered, 15)
          )
        : set
    }
  }

  beforeEach(() => {
    installSessionOutcomeHandoffReader(async ({ threadId }) => {
      const reviews: Review[] =
        threadId === 'hth_a'
          ? [{ id: 'rev_1', decision: 'approve', current: true }]
          : [{ id: 'rev_2', decision: 'request_changes', current: true }]
      return { ok: true, data: detail(threadId, 'emp_a', reviews) } as never
    })
  })

  it('is answered on the newest ask’s thread, and not at all before that ask reached them', async () => {
    await expect(
      verifySessionOutcomeExternalCondition(named, undefined, askedTwice(), 'o1')
    ).resolves.toEqual({
      verified: false,
      reason: 'An ownership delivery receipt and exact recipient are required.'
    })
    await expect(
      verifySessionOutcomeExternalCondition(named, undefined, askedTwice('hth_c'), 'o1')
    ).resolves.toMatchObject({
      verified: true,
      receipt: 'handoff-review:hth_c:rev_2:request_changes'
    })
  })

  it('retires the answer to the first ask once, and reads theirs again from the second', async () => {
    const chain = askedTwice('hth_c', firstAnswer)
    const first = await verifySessionOutcomeProgress(
      {} as never,
      chain,
      chain.outcomeSet!.outcomes[0]!
    )
    expect(first.set.evidenceHistory?.map((entry) => entry.receipt)).toEqual([firstAnswer])
    expect(first.set.outcomes[0]!.evidence.map((entry) => entry.receipt)).toEqual([
      'handoff-review:hth_c:rev_2:request_changes'
    ])
    // Read from the thread the condition reads now, it stands: the next pass changes nothing.
    const again = { ...chain, outcomeSet: first.set }
    const second = await verifySessionOutcomeProgress({} as never, again, first.set.outcomes[0]!)
    expect(second.set).toEqual(first.set)
  })

  it('retires it as soon as the second ask exists, before it is delivered', async () => {
    const chain = askedTwice(undefined, firstAnswer)
    const result = await verifySessionOutcomeProgress(
      {} as never,
      chain,
      chain.outcomeSet!.outcomes[0]!
    )
    expect(result.set.evidenceHistory?.map((entry) => entry.receipt)).toEqual([firstAnswer])
    expect(result.set.outcomes[0]!.evidence).toEqual([])
    expect(result.reason).toBe('An ownership delivery receipt and exact recipient are required.')
  })

  it('keeps the only ask’s answer: one Review of a person reads as it always did', async () => {
    const chain = chainOf()
    const outcome = { ...chain.outcomeSet!.outcomes[0]!, conditions: [named] }
    const set = recordSessionOutcomeEvidence(
      { ...chain.outcomeSet!, outcomes: [outcome] },
      sessionOutcomeVerifiedEvidence(outcome, named, firstAnswer, 15)
    )
    const result = await verifySessionOutcomeProgress(
      {} as never,
      { ...chain, outcomeSet: set },
      set.outcomes[0]!
    )
    expect(result.set).toEqual(set)
  })
})

describe('two Outcomes that each review the same person', () => {
  const named = (id: string) =>
    ({ id, kind: 'review', target: 'emp_a', recipientId: 'emp_a' }) as SessionOutcomeCondition
  const answerA = 'handoff-review:hth_a:rev_1:approve'

  /**
   * Outcome A asks emp_a on `h1`; B, which depends on A, asks them on `hB` — sent on `thread`, or
   * still queued behind A. A's condition holds `answered`, if any.
   */
  function twoOutcomes(thread?: string, answered?: string): SessionChain {
    const chain = chainOf()
    const first = chain.steps[0]!
    if (first.kind !== 'handoff') {
      throw new Error('fixture')
    }
    const ofB = {
      ...first,
      id: 'hB',
      status: thread ? ('delivered' as const) : ('queued' as const),
      handoff: {
        ...first.handoff,
        savedAt: 20,
        recipients: [
          {
            employeeId: 'emp_a',
            name: 'Jordan Taylor',
            operationId: 'op_a_b',
            delivery: thread ? ('sent' as const) : ('pending' as const),
            ...(thread ? { threadId: thread, at: 30 } : {})
          }
        ]
      }
    }
    const base = chain.outcomeSet!.outcomes[0]!
    const a = { ...base, id: 'oA', conditions: [named('c_a')], stepIds: ['h1'] }
    const b = { ...base, id: 'oB', dependsOn: ['oA'], conditions: [named('c_b')], stepIds: ['hB'] }
    const set = { ...chain.outcomeSet!, outcomes: [a, b] }
    return {
      ...chain,
      steps: [first, ofB],
      outcomeSet: answered
        ? recordSessionOutcomeEvidence(
            set,
            sessionOutcomeVerifiedEvidence(a, a.conditions[0]!, answered, 15)
          )
        : set
    }
  }

  beforeEach(() => {
    installSessionOutcomeHandoffReader(async ({ threadId }) => {
      const reviews: Review[] =
        threadId === 'hth_a'
          ? [{ id: 'rev_1', decision: 'approve', current: true }]
          : [{ id: 'rev_2', decision: 'request_changes', current: true }]
      return { ok: true, data: detail(threadId, 'emp_a', reviews) } as never
    })
  })

  it('reads each condition on its own Outcome’s ask: A’s while B’s is still queued', async () => {
    await expect(
      verifySessionOutcomeExternalCondition(named('c_a'), undefined, twoOutcomes(), 'oA')
    ).resolves.toMatchObject({ verified: true, receipt: answerA })
    // B waits for B's own ask, and never takes A's answer as its own.
    await expect(
      verifySessionOutcomeExternalCondition(named('c_b'), undefined, twoOutcomes(), 'oB')
    ).resolves.toEqual({
      verified: false,
      reason: 'An ownership delivery receipt and exact recipient are required.'
    })
    await expect(
      verifySessionOutcomeExternalCondition(named('c_b'), undefined, twoOutcomes('hth_c'), 'oB')
    ).resolves.toMatchObject({
      verified: true,
      receipt: 'handoff-review:hth_c:rev_2:request_changes'
    })
  })

  it('keeps A’s answer and A’s gate, so a B that depends on A is never held for good', async () => {
    const answered = twoOutcomes(undefined, answerA)
    const result = await verifySessionOutcomeProgress(
      {} as never,
      answered,
      answered.outcomeSet!.outcomes[0]!
    )
    expect(result.set).toEqual(answered.outcomeSet)
    expect(result.reason).toBeUndefined()
    // B's ask of the same person replaces nothing of A's: A's ask is out until answered, then done.
    expect(upNextReviewReplaced(answered, 'h1')).toBe(false)
    expect(upNextReviewSettled(answered, 'h1')).toBe(true)
    expect(upNextReviewOpen(twoOutcomes(), 'h1')).toBe(true)
    expect(upNextReviewOpen(twoOutcomes(), 'hB')).toBe(true)
  })
})

describe('the legacy recipient-less review condition', () => {
  it('is not opened by a hub reply of any decision', async () => {
    hub({ hth_b: [{ id: 'rev_9', decision: 'approve', current: true }] })
    const legacy = {
      id: 'c_me',
      kind: 'review',
      target: 'o1'
    } as unknown as SessionOutcomeCondition
    // It never reaches the hub verifier at all…
    await expect(
      verifySessionOutcomeExternalCondition(legacy, undefined, chainOf(), 'o1')
    ).resolves.toMatchObject({ verified: false })
    // …and its own verifier still asks the person, approval on the hub notwithstanding.
    await expect(
      verifySessionOutcomeCondition(legacy, '/w', undefined, chainOf(), 'o1')
    ).resolves.toEqual({ verified: false, reason: 'Your review is required for this version.' })
  })
})
