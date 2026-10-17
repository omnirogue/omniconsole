/**
 * A reviewer's "needs changes" with work held behind the review (owner's ruling B): nothing held is
 * released, the notes reach THIS conversation's own agent exactly once per reply — across passes
 * and across a restart — and when that turn ends every reviewer of the round is asked again
 * (ruling C, and the owner-equivalent decision that an approval counts only for what it approved).
 *
 * Real: the prompt queue's own persistence and the fix-up driver. Stubbed only where the world is:
 * the pane's readiness, the send door, the conversation lookup and the hub thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const pane = vi.hoisted(() => ({
  ready: true,
  version: 'turn-1' as string | undefined,
  unverifiable: false,
  open: true,
  sent: [] as string[],
  /** The send failed after bytes moved: its result is unknown. */
  refuse: false,
  /** The door refused before any byte moved. */
  notSent: false
}))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: pane.ready,
    free: pane.ready,
    unverifiable: pane.unverifiable,
    ...(pane.version ? { version: pane.version } : {})
  })
}))
vi.mock('./conversation-delivery', async () => {
  const { ConversationNotSentError } = await import('./conversation-delivery-not-sent')
  return {
    deliverToConversation: async (_runtime: unknown, _source: unknown, text: string) => {
      if (pane.notSent) {
        throw new ConversationNotSentError('This terminal conversation is no longer open.')
      }
      if (pane.refuse) {
        throw new Error('terminal_handle_stale')
      }
      pane.sent.push(text)
      return { door: 'pty' as const, deliveredAt: 99 }
    }
  }
})
vi.mock('./session-outcome-conversation-turn', () => ({
  sameConversationSource: () =>
    pane.open ? { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const } : null
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import { SESSION_RECOVERING_MAX_MS } from '../../shared/session-outcome-block'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionOutcomeEvidence } from '../../shared/session-outcome-types'
import {
  SESSION_RUN_CONTINUATION_CODES,
  readSessionRunHeldContinuation
} from '../../shared/session-run-held-continuation'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import {
  installSessionOutcomeHandoffReader,
  verifySessionOutcomeExternalCondition
} from './session-outcome-external-evidence'
import { PROMPT_QUEUE_UNCONFIRMED_DELIVERY } from './prompt-queue-drain'
import { upNextHeldContinuation } from './up-next-held-gates'
import { upNextReviewReplies, upNextReviewSettled } from './up-next-person-facts'
import { UP_NEXT_REVIEW_FIX_NO_CONVERSATION, advanceUpNextHeldReviews } from './up-next-review-fix'

const ROW = conversationSourceRowKey({ worktreeId: 'wt', paneKey: 'tab-1:leaf-1' })
const SOURCE = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const CHANGES = 'handoff-review:hth_uma:hrv_1:request_changes'
const APPROVED = 'handoff-review:hth_iris:hrv_2:approve'

const reviewer = (employeeId: string, name: string, threadId: string) => ({
  employeeId,
  name,
  operationId: `op_${employeeId}_1`,
  delivery: 'sent' as const,
  threadId,
  at: 5
})

function review(people: ReturnType<typeof reviewer>[]): SessionChainHandoffStep {
  return {
    id: 'review',
    kind: 'handoff',
    status: 'delivered',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Intro',
      sessionLabel: 'Intro',
      recipients: people,
      action: 'review',
      disposition: 'feedback',
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true,
      note: 'Intro',
      savedAt: 1,
      capturedAt: 2
    }
  }
}

const answer = (employeeId: string, receipt: string): SessionOutcomeEvidence => ({
  id: `ev_${employeeId}`,
  outcomeId: 'o1',
  conditionId: `review_${employeeId}`,
  outcomeRevision: 1,
  conditionKey: 'k',
  kind: 'review',
  target: employeeId,
  receipt,
  verifiedAt: 30,
  verifier: 'execution-host'
})

function run(people: ReturnType<typeof reviewer>[], evidence: SessionOutcomeEvidence[]) {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: ROW,
    auto: true,
    steps: [review(people)],
    currentIndex: 1,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [
        {
          id: 'o1',
          title: 'Intro reviewed',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['review'],
          conditions: people.map((person) => ({
            id: `review_${person.employeeId}`,
            kind: 'review' as const,
            target: person.employeeId,
            recipientId: person.employeeId
          })),
          actions: [],
          revision: 1,
          status: 'pending',
          evidence
        }
      ],
      removals: [],
      attempts: [],
      completedSteps: ['review'],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 3
    }
  } as SessionChain
}

const UMA = reviewer('emp_uma', 'Uma Evans', 'hth_uma')
const IRIS = reviewer('emp_iris', 'Iris Allen', 'hth_iris')

/**
 * One host: the run, its held Improve, and the conversation's real prompt queue. `holds: false` is
 * a Review as the last block: nothing is queued behind it.
 */
function host(initial: SessionChain, holds = true) {
  let chain = initial
  const state = { promptQueues: {} } as unknown as PersistedState
  const prompts = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const runtime = {
    listSessionChains: () => [chain],
    readUpNextDrafts: (rowKey: string) =>
      rowKey === ROW && holds
        ? {
            subject: SOURCE,
            entries: [
              {
                id: 'draft:improve',
                input: { kind: 'agent', template: 'improve', instruction: 'Improve it.' } as never,
                held: { reviewStepId: 'review', committedAt: 3 },
                createdAt: 3
              }
            ],
            updatedAt: 3
          }
        : null,
    readPromptQueue: (key: string) => prompts.readPromptQueue(key),
    enqueuePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['enqueuePromptQueueEntry']>
    ) => prompts.enqueuePromptQueueEntry(...args),
    removePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['removePromptQueueEntry']>
    ) => prompts.removePromptQueueEntry(...args),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => prompts.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => prompts.settlePromptQueueEntry(...args)
  }
  return {
    runtime,
    prompts,
    chain: () => chain,
    set: (next: SessionChain) => {
      chain = next
    },
    /** One host pass; `epoch` is the process — a new one is a restart. */
    pass: (now = 100, epoch = 'epoch-1') =>
      advanceUpNextHeldReviews({
        runtime: runtime as never,
        read: () => chain,
        save: (next) => {
          chain = next
        },
        epoch,
        now
      })
  }
}

beforeEach(() => {
  Object.assign(pane, {
    ready: true,
    version: 'turn-1',
    unverifiable: false,
    open: true,
    sent: [],
    refuse: false,
    notSent: false
  })
  installSessionOutcomeHandoffReader(async ({ threadId }) => ({
    ok: true,
    data: {
      thread: { id: threadId },
      files: [],
      reviews: [
        {
          id: 'hrv_1',
          decision: 'request_changes',
          version_ids: [],
          current: true,
          note: 'Tighten the intro.'
        }
      ],
      entries: []
    } as never
  }))
})

describe('a reviewer asked for changes', () => {
  it('hands their notes to this conversation’s agent once, across passes and a restart', async () => {
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await h.pass()

    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Uma Evans asked for changes (round 1):')
    expect(pane.sent[0]).toContain('Tighten the intro.')
    expect(pane.sent[0]).toContain('The work queued after that review waits until they are made.')
    const [fix] = h.chain().outcomeSet!.heldContinuation!.fixes!
    expect(fix).toMatchObject({
      receipt: CHANGES,
      employeeId: 'emp_uma',
      round: 1,
      note: 'Tighten the intro.',
      turnVersion: 'turn-1',
      deliveredAt: 99
    })
    // The prompt queue carries it, with its receipt, like any prompt to this agent.
    expect(h.prompts.readPromptQueue(ROW)?.entries).toMatchObject([
      { id: fix!.promptId, state: 'delivered', deliveryEpoch: 'epoch-1' }
    ])

    await h.pass(200)
    await h.pass(300, 'epoch-2')
    expect(pane.sent).toHaveLength(1)
    // The review is still out on them: the fix is what the run is doing now.
    expect(upNextReviewReplies(h.chain(), 'review', 300)).toMatchObject({
      replied: 1,
      approved: 0,
      fixing: true,
      changes: [{ employeeId: 'emp_uma', name: 'Uma Evans', round: 1, note: 'Tighten the intro.' }]
    })
  })

  it('asks the same person again, round 2, when the agent’s turn ends', async () => {
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await h.pass()
    pane.version = 'turn-2'
    await h.pass(400)

    const step = h.chain().steps[0] as SessionChainHandoffStep
    expect(step.status).toBe('queued')
    expect(step.handoff.reask).toBe(true)
    expect(step.handoff.capturedAt).toBeUndefined()
    const person = step.handoff.recipients[0]!
    expect(person).toMatchObject({ delivery: 'pending', round: 2, threadId: 'hth_uma' })
    expect(person.operationId).not.toBe('op_emp_uma_1')
    const set = h.chain().outcomeSet!
    expect(set.completedSteps).toEqual([])
    expect(set.outcomes[0]!.evidence).toEqual([])
    expect(set.evidenceHistory?.map((entry) => entry.receipt)).toEqual([CHANGES])
    expect(set.heldContinuation!.fixes![0]!.reaskedAt).toBe(400)
    // Their old reply answers nothing now: the review waits for a new one.
    expect(upNextReviewReplies(h.chain(), 'review', 400)).toMatchObject({
      replied: 0,
      round: 2,
      fixing: false
    })
    await h.pass(500)
    expect(pane.sent).toHaveLength(1)
  })

  it('waits for every reviewer of the round, then sends only the notes that asked for changes', async () => {
    const h = host(run([UMA, IRIS], [answer('emp_uma', CHANGES)]))
    await h.pass()
    expect(pane.sent).toEqual([])
    // Their words are on the record the moment they reply.
    expect(upNextReviewReplies(h.chain(), 'review', 100)).toMatchObject({
      replied: 1,
      total: 2,
      approved: 0,
      changes: [{ employeeId: 'emp_uma', note: 'Tighten the intro.' }]
    })

    const current = h.chain()
    const outcome = current.outcomeSet!.outcomes[0]!
    h.set({
      ...current,
      outcomeSet: {
        ...current.outcomeSet!,
        outcomes: [{ ...outcome, evidence: [...outcome.evidence, answer('emp_iris', APPROVED)] }]
      }
    })
    await h.pass(200)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Uma Evans')
    expect(pane.sent[0]).not.toContain('Iris Allen asked')
    // "1 of 2 said OK" is still a paused review.
    expect(upNextReviewReplies(h.chain(), 'review', 200)).toMatchObject({ approved: 1, total: 2 })
  })

  it('waits for the agent to finish its turn before handing the notes over', async () => {
    pane.ready = false
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await h.pass()
    expect(pane.sent).toEqual([])
    pane.ready = true
    await h.pass(200)
    expect(pane.sent).toHaveLength(1)
  })

  it('says why when the conversation is gone, and sends nothing', async () => {
    pane.open = false
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await h.pass()
    expect(pane.sent).toEqual([])
    expect(upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])?.refused).toBe(
      UP_NEXT_REVIEW_FIX_NO_CONVERSATION
    )
  })

  it('never sends the notes twice when a send cannot be accounted for', async () => {
    // Bytes may have moved before it failed: the agent may have the notes, so they are not re-sent.
    pane.refuse = true
    const refused = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await refused.pass()
    expect(refused.chain().outcomeSet!.heldContinuation!.fixes![0]!.failed).toBe(
      'terminal_handle_stale'
    )
    pane.refuse = false
    await refused.pass(200)
    expect(pane.sent).toEqual([])

    // A restart between the durable `sending` receipt and the result: the queue drain settles it
    // as unconfirmed, and the run records that rather than sending a second copy.
    const stranded = host(run([UMA], [answer('emp_uma', CHANGES)]))
    pane.ready = false
    await stranded.pass()
    const promptId = 'review-fix-stranded'
    const chain = stranded.chain()
    stranded.set({
      ...chain,
      outcomeSet: {
        ...chain.outcomeSet!,
        heldContinuation: {
          ...chain.outcomeSet!.heldContinuation!,
          fixes: chain.outcomeSet!.heldContinuation!.fixes!.map((entry) => ({
            ...entry,
            promptId,
            turnVersion: 'turn-1'
          }))
        }
      }
    })
    stranded.prompts.enqueuePromptQueueEntry(SOURCE, {
      id: promptId,
      text: 'notes',
      createdAt: 1,
      state: 'queued'
    })
    stranded.prompts.markPromptQueueEntrySendingAndFlush(ROW, promptId, {
      operationId: 'up-next:gone',
      deliveryEpoch: 'epoch-0'
    })
    pane.ready = true
    await stranded.pass(200)
    expect(pane.sent).toEqual([])
    stranded.prompts.settlePromptQueueEntry(ROW, promptId, {
      state: 'failed',
      reason: PROMPT_QUEUE_UNCONFIRMED_DELIVERY
    })
    await stranded.pass(300)
    expect(pane.sent).toEqual([])
    expect(stranded.chain().outcomeSet!.heldContinuation!.fixes![0]!.failed).toBe(
      PROMPT_QUEUE_UNCONFIRMED_DELIVERY
    )
  })
})

describe('a Review with nothing queued behind it (the last block)', () => {
  it('hands "needs changes" to the agent once, then asks the same person again', async () => {
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]), false)
    await h.pass()
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Uma Evans asked for changes (round 1):')
    expect(pane.sent[0]).toContain('Tighten the intro.')
    // Nothing waits behind it, so the agent is not told that something does.
    expect(pane.sent[0]).toContain('This work is not finished until they approve the new version.')
    expect(pane.sent[0]).not.toContain('The work queued after that review')
    await h.pass(200)
    await h.pass(300, 'epoch-2')
    expect(pane.sent).toHaveLength(1)

    pane.version = 'turn-2'
    await h.pass(400)
    const step = h.chain().steps[0] as SessionChainHandoffStep
    expect(step.handoff.reask).toBe(true)
    expect(step.handoff.recipients[0]).toMatchObject({
      delivery: 'pending',
      round: 2,
      threadId: 'hth_uma'
    })
    expect(h.chain().outcomeSet!.outcomes[0]!.evidence).toEqual([])
    // Still a gate: only their answer on the new version can finish the run.
    expect(upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])).toEqual({
      reviewStepIds: ['review']
    })
    await h.pass(500)
    expect(pane.sent).toHaveLength(1)
  })

  it('acts on nothing once every named person approved', async () => {
    const approved = [
      answer('emp_uma', 'handoff-review:hth_uma:hrv_3:approve'),
      answer('emp_iris', APPROVED)
    ]
    const h = host(run([UMA, IRIS], approved), false)
    await h.pass()
    expect(pane.sent).toEqual([])
    expect(h.chain().outcomeSet!.heldContinuation).toBeUndefined()
    expect(upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])).toBeNull()
  })
})

describe('notes the door refused before any byte moved', () => {
  it('are sent again under a new prompt id, as one refusal that keeps its clock, then once', async () => {
    pane.notSent = true
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    const held = () => upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])
    const fix = () => h.chain().outcomeSet!.heldContinuation!.fixes![0]!
    await h.pass(100)
    const first = fix().promptId
    expect(pane.sent).toEqual([])
    expect(fix().failed).toBeUndefined()
    // Nothing was sent, so nothing is left in the person's queue claiming it was tried.
    expect(h.prompts.readPromptQueue(ROW)?.entries ?? []).toEqual([])
    expect(held()).toMatchObject({
      refused: 'This terminal conversation is no longer open.',
      refusedSince: 100
    })

    await h.pass(200)
    expect(fix().promptId).not.toBe(first)
    // Still the same refusal: its clock runs from when it first appeared.
    expect(held()?.refusedSince).toBe(100)

    pane.notSent = false
    await h.pass(300)
    await h.pass(400)
    expect(pane.sent).toHaveLength(1)
    expect(fix()).toMatchObject({ deliveredAt: 99 })
    expect(fix().failed).toBeUndefined()
    expect(held()?.refused).toBeUndefined()
    expect(h.prompts.readPromptQueue(ROW)?.entries).toMatchObject([
      { id: fix().promptId, state: 'delivered' }
    ])
  })
})

describe('a refusal at the end of a long fix turn', () => {
  it('reads recovering from when it appeared, not from the reply that started the fix', async () => {
    const h = host(run([UMA], [answer('emp_uma', CHANGES)]))
    await h.pass(100)
    expect(pane.sent).toHaveLength(1)
    // The agent works on the notes for twice the recovering maximum, then one reading fails.
    const later = 100 + 2 * SESSION_RECOVERING_MAX_MS
    pane.unverifiable = true
    await h.pass(later)
    const held = upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])!
    expect(held).toMatchObject({ refusedSince: later })
    // The stamp the terminal writer derives: `since` is the "needs changes" reply's moment.
    const stamp = { ...h.chain().outcomeSet!.heldContinuation!, since: 100, ...held }
    expect(readSessionRunHeldContinuation(stamp, later + 1_000)).toMatchObject({
      phase: 'recovering',
      code: SESSION_RUN_CONTINUATION_CODES.refused
    })
    expect(
      readSessionRunHeldContinuation(stamp, later + SESSION_RECOVERING_MAX_MS + 1)
    ).toMatchObject({ phase: 'failed' })

    // The next good reading, while the fix turn still runs, clears it.
    pane.unverifiable = false
    pane.ready = false
    await h.pass(later + 2_000)
    expect(upNextHeldContinuation(h.runtime, h.chain(), [h.chain()])?.refused).toBeUndefined()
  })
})

describe('an approval of the version before the fix', () => {
  /** What the verifier records for this reviewer's condition, or null when it verifies nothing. */
  async function verified(chain: SessionChain, employeeId: string): Promise<SessionChain | null> {
    const outcome = chain.outcomeSet!.outcomes[0]!
    const condition = outcome.conditions.find((entry) => entry.recipientId === employeeId)!
    const result = await verifySessionOutcomeExternalCondition(condition, undefined, chain, 'o1')
    if (!result.verified) {
      return null
    }
    const evidence = sessionOutcomeVerifiedEvidence(outcome, condition, result.receipt, 500)
    return {
      ...chain,
      outcomeSet: recordSessionOutcomeEvidence(chain.outcomeSet!, evidence)
    }
  }

  /** The round-2 request landed on each reviewer's same thread. */
  function delivered(chain: SessionChain): SessionChain {
    return {
      ...chain,
      steps: chain.steps.map((step) =>
        step.kind === 'handoff'
          ? {
              ...step,
              status: 'delivered' as const,
              handoff: {
                ...step.handoff,
                recipients: step.handoff.recipients.map((person) => ({
                  ...person,
                  delivery: 'sent' as const
                }))
              }
            }
          : step
      )
    }
  }

  it('does not count once the work changed: only both round-2 approvals release', async () => {
    // Iris approved v1 and Uma asked for changes; the agent fixes them.
    const h = host(run([UMA, IRIS], [answer('emp_uma', CHANGES), answer('emp_iris', APPROVED)]))
    await h.pass(100)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Uma Evans and Iris Allen will be asked to review')
    pane.version = 'turn-2'
    await h.pass(400)

    // Both are asked again, each on their own thread, round 2, under a fresh key.
    const step = h.chain().steps[0] as SessionChainHandoffStep
    expect(step.handoff.recipients).toMatchObject([
      { employeeId: 'emp_uma', delivery: 'pending', round: 2, threadId: 'hth_uma' },
      { employeeId: 'emp_iris', delivery: 'pending', round: 2, threadId: 'hth_iris' }
    ])
    expect(step.handoff.recipients[1]!.operationId).not.toBe('op_emp_iris_1')
    const set = h.chain().outcomeSet!
    expect(set.outcomes[0]!.evidence).toEqual([])
    expect(set.evidenceHistory?.map((entry) => entry.receipt)).toEqual([CHANGES, APPROVED])
    expect(set.heldContinuation!.superseded).toEqual([APPROVED])
    expect(upNextReviewReplies(h.chain(), 'review', 400)).toMatchObject({
      replied: 0,
      approved: 0,
      round: 2
    })
    expect(upNextReviewSettled(h.chain(), 'review')).toBe(false)

    // The hub still lists Iris's v1 OK as current on his thread; round-2 replies come in after.
    const reviews: Record<string, { id: string; decision: string }[]> = {
      hth_iris: [{ id: 'hrv_2', decision: 'approve' }],
      hth_uma: [{ id: 'hrv_1', decision: 'request_changes' }]
    }
    installSessionOutcomeHandoffReader(async ({ threadId }) => ({
      ok: true,
      data: {
        thread: { id: threadId, recipient_employee_id: `emp_${threadId.slice(4)}` },
        files: [],
        reviews: reviews[threadId]!.map((review) => ({
          ...review,
          version_ids: [],
          current: true
        })),
        entries: []
      } as never
    }))
    let chain = delivered(h.chain())
    expect(await verified(chain, 'emp_iris')).toBeNull()
    expect(await verified(chain, 'emp_uma')).toBeNull()

    reviews.hth_iris!.push({ id: 'hrv_3', decision: 'approve' })
    chain = (await verified(chain, 'emp_iris'))!
    expect(upNextReviewSettled(chain, 'review')).toBe(false)
    reviews.hth_uma!.push({ id: 'hrv_4', decision: 'approve' })
    chain = (await verified(chain, 'emp_uma'))!
    expect(upNextReviewReplies(chain, 'review', 600)).toMatchObject({ approved: 2, total: 2 })
    expect(upNextReviewSettled(chain, 'review')).toBe(true)
  })
})
