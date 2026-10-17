/**
 * A person Review with work held behind it, through the REAL outcome host: the durable commit, the
 * tick, the step runner's own delivery, the review verifier and the single terminal writer.
 *
 * Stubbed only where the world is: the hub (one thread per request), the pane's readiness and the
 * send door into it. The draft store is read, never released from, so what is proven here is the
 * host's side of the owner's rulings — the last reply never seals a run that still holds work
 * (A, F); "needs changes" goes to this conversation's agent once, across ticks and a restart, and
 * the same person is asked again when that turn ends (B, C); a Hand off still seals on delivery (E).
 * A Review with nothing held behind it (the last block) is held the same way: only an OK from
 * every named person seals it, and a run an older build sealed stays as it is. A second Review of
 * the same person, released into the same run after the first (Draft → Review → Improve → Review),
 * is answered on its own thread: the first answer never finishes it, and never gets it stuck.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const pane = vi.hoisted(() => ({ ready: true, version: 'turn-1', sent: [] as string[] }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: pane.ready,
    free: pane.ready,
    unverifiable: false,
    version: pane.version
  })
}))
vi.mock('./conversation-delivery', () => ({
  deliverToConversation: async (_runtime: unknown, _source: unknown, text: string) => {
    pane.sent.push(text)
    return { door: 'pty' as const, deliveredAt: Date.now() }
  }
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { HandoffDetail, HandoffSendCardless } from '../../shared/console-handoff-contract'
import type { PersistedState } from '../../shared/persisted-state-types'
import type {
  SessionChain,
  SessionChainHandoffStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type { UpNextDraftRecord } from '../../shared/up-next-draft-schema'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeDefinition
} from '../../shared/session-outcome-types'
import { auditSessionRuns } from '../../shared/session-run-audit'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import { installSessionOutcomeHandoffReader } from './session-outcome-external-evidence'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import {
  completionHarness,
  type CompletionHarness
} from './session-outcome-completion-test-harness'
import { upNextHeldContinuation } from './up-next-held-gates'
import { upNextReviewReplies, upNextReviewSettled } from './up-next-person-facts'

const ROW = 'row:source'
const harnesses: CompletionHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).toReversed()) {
    await h.service.suspend()
    await h.dispose()
  }
})

/** One hub: a thread per request key, each with the reviews a test writes on it. */
function hub() {
  const threads = new Map<string, HandoffDetail>()
  const byKey = new Map<string, string>()
  const sent: HandoffSendCardless[] = []
  installSessionOutcomeHandoffTransport({
    principal: async () => 'company:person',
    hub: {
      upload: async (_task, file) => ({ path: file.name, sha256: file.sha256 }),
      send: async () => {
        throw new Error('Only card-less requests are used here.')
      },
      sendCardless: async (input) => {
        sent.push(input)
        const id = byKey.get(input.operationId) ?? `hth_${byKey.size + 1}`
        byKey.set(input.operationId, id)
        threads.set(id, {
          thread: {
            id,
            board_task_id: null,
            author_employee_id: 'emp_author',
            recipient_employee_id: input.recipient,
            title: input.title,
            state: 'open',
            action: input.action ?? null,
            due_at: null,
            parent_thread_id: null,
            delivery_id: null,
            updated: new Date().toISOString()
          },
          files: [],
          reviews: [],
          entries: []
        })
        return { thread_id: id }
      },
      uploadThreadFile: async (input) => ({ thread_id: input.threadId }),
      isRejected: () => false
    }
  })
  installSessionOutcomeHandoffReader(async ({ threadId }) =>
    threads.has(threadId)
      ? { ok: true, data: threads.get(threadId)! }
      : { ok: false, error: { code: 'not_found', message: 'No such thread.' } }
  )
  return {
    sent,
    reply: (threadId: string, id: string, decision: 'approve' | 'request_changes', note?: string) =>
      threads.get(threadId)!.reviews.push({
        id,
        decision,
        version_ids: [],
        current: true,
        ...(note ? { note } : {})
      }),
    /** A reply on the thread that is words only: neither "Looks good" nor "Needs changes". */
    comment: (threadId: string, body: string) => {
      const detail = threads.get(threadId)!
      detail.thread = { ...detail.thread, state: 'replied' }
      detail.entries.push({
        id: `hen_${detail.entries.length + 1}`,
        kind: 'reply',
        body,
        created: new Date().toISOString()
      })
    }
  }
}

/** The run's own prompt queue and draft store, kept across a restart like the profile keeps them. */
function stores() {
  const state = { promptQueues: {} } as unknown as PersistedState
  const prompts = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  let held: UpNextDraftRecord | null = null
  return {
    prompts,
    hold: (reviewStepId: string | null) => {
      held = reviewStepId
        ? {
            subject: { kind: 'pty', worktreeId: 'folder:outcome', paneKey: 'source' },
            entries: [
              {
                id: 'draft:improve',
                input: { kind: 'agent', template: 'improve', instruction: 'Fix it.' } as never,
                held: { reviewStepId, committedAt: 1 },
                createdAt: 1
              }
            ],
            updatedAt: 1
          }
        : null
    },
    /** Wire them into one host; the pre-tick is given nothing to release, so the gate is observed. */
    attach: (h: CompletionHarness) => {
      vi.spyOn(h.runtime, 'readUpNextDrafts').mockImplementation((rowKey) =>
        rowKey === ROW ? held : null
      )
      vi.spyOn(h.runtime, 'listUpNextDrafts').mockReturnValue({})
      vi.spyOn(h.runtime, 'listPromptQueues').mockImplementation(() => prompts.listPromptQueues())
      vi.spyOn(h.runtime, 'readPromptQueue').mockImplementation((key) =>
        prompts.readPromptQueue(key)
      )
      vi.spyOn(h.runtime, 'enqueuePromptQueueEntry').mockImplementation((source, entry) =>
        prompts.enqueuePromptQueueEntry(source, entry)
      )
      vi.spyOn(h.runtime, 'markPromptQueueEntrySendingAndFlush').mockImplementation(
        (key, id, delivery) => prompts.markPromptQueueEntrySendingAndFlush(key, id, delivery)
      )
      vi.spyOn(h.runtime, 'settlePromptQueueEntry').mockImplementation((key, id, settlement) =>
        prompts.settlePromptQueueEntry(key, id, settlement)
      )
    }
  }
}

type Reviewer = { employeeId: string; name: string }
const UMA: Reviewer = { employeeId: 'emp_uma', name: 'Uma Evans' }
const IRIS: Reviewer = { employeeId: 'emp_iris', name: 'Iris Allen' }

function personStep(
  disposition: 'feedback' | 'ownership-transfer',
  people: readonly Reviewer[],
  id = 'review'
): SessionChainHandoffStep {
  return {
    id,
    kind: 'handoff',
    outcomeId: 'delivery',
    status: 'queued',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Intro',
      sessionLabel: 'Intro',
      recipients: people.map((person) => ({
        ...person,
        operationId: `op_${person.employeeId.slice(4)}_round_1`,
        delivery: 'pending' as const
      })),
      action: disposition === 'feedback' ? 'review' : 'edit',
      disposition,
      deliverables: { kind: 'files', paths: [] },
      includeSummary: false,
      note: 'Please look at the intro.',
      savedAt: 1
    }
  }
}

/** The Outcome a person block finishes at, with one pair of conditions per person as compiled. */
function delivery(
  disposition: 'feedback' | 'ownership-transfer',
  people: readonly Reviewer[],
  stepIds: string[]
): SessionOutcomeDefinition {
  return {
    id: 'delivery',
    title: 'Intro reviewed',
    finish: 'human-handoff',
    dependsOn: [],
    stepIds,
    actions: [],
    // One pair per person, as the compiler writes them; the first keeps the one-person ids.
    conditions: people.flatMap(({ employeeId }, index) => {
      const suffix = index ? `_${index + 1}` : ''
      const own = { target: employeeId, recipientId: employeeId }
      return [
        { id: `handoff${suffix}`, kind: 'handoff' as const, ...own },
        ...(disposition === 'feedback'
          ? [{ id: `feedback${suffix}`, kind: 'review' as const, ...own }]
          : [])
      ]
    })
  }
}

async function started(
  disposition: 'feedback' | 'ownership-transfer',
  heldBehind: string | null = 'review',
  people: readonly Reviewer[] = [UMA],
  before: SessionChainStep[] = []
) {
  const h = completionHarness()
  harnesses.push(h)
  const world = hub()
  const kept = stores()
  kept.hold(heldBehind)
  kept.attach(h)
  Object.assign(pane, { ready: true, version: 'turn-1', sent: [] })
  const steps = [...before, personStep(disposition, people)]
  await h.service.commit(
    { ...h.chain(), steps },
    {
      source: 'user',
      expectedRevision: 0,
      outcomes: [
        delivery(
          disposition,
          people,
          steps.map((step) => step.id)
        )
      ]
    }
  )
  // The stages before the review ran: recorded as the tick records a finished one.
  before.forEach((step) => finishStage(h, step.id))
  await ticks(h, 4)
  return { h, world, kept }
}

async function ticks(h: CompletionHarness, count = 1): Promise<void> {
  for (let index = 0; index < count; index++) {
    await h.tick()
  }
}

const run = (h: CompletionHarness): SessionChain => h.service.get('chain')
const reading = (h: CompletionHarness) => readSessionRun(run(h).outcomeSet!, { now: h.clock.now })

/**
 * A stage the agent ran to its end, recorded as the tick records one: its id enters
 * `completedSteps`. The agent itself is the world, as the hub and the pane are here.
 */
function finishStage(h: CompletionHarness, stepId: string): void {
  const chain = run(h)
  const completed = [...(chain.outcomeSet!.completedSteps ?? []), stepId]
  const next = chain.steps.findIndex((step) => !completed.includes(step.id))
  h.runtime.replaceSessionChainOutcomesAndFlush(
    {
      ...chain,
      currentIndex: next === -1 ? chain.steps.length : next,
      outcomeSet: { ...chain.outcomeSet!, completedSteps: completed }
    },
    chain.outcomeSet!.revision
  )
}

describe('a Review with work held behind it, on the real host', () => {
  it('waits on the reviewer, and is never sealed by an OK while the work is still held', async () => {
    const { h, world } = await started('feedback')
    expect(world.sent).toHaveLength(1)
    expect(reading(h)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans', attention: [] })

    world.reply('hth_1', 'hrv_1', 'approve')
    await ticks(h, 2)
    const chain = run(h)
    expect(chain.outcomeSet!.completion).toBeUndefined()
    expect(chain.outcomeSet!.disposition).toBeUndefined()
    expect(chain.state).toBe('waiting')
    expect(chain.outcomeSet!.heldContinuation).toMatchObject({ reviewStepIds: ['review'] })
    expect(reading(h)).toMatchObject({ phase: 'active', attention: [] })
    expect(upNextReviewSettled(chain, 'review')).toBe(true)
    expect(pane.sent).toEqual([])
  })

  it('seals on the OK when nothing is held behind the review', async () => {
    const { h, world } = await started('feedback', null)
    world.reply('hth_1', 'hrv_1', 'approve')
    await ticks(h, 2)
    expect(run(h).state).toBe('done')
    expect(run(h).outcomeSet!.completion).toBeDefined()
    expect(run(h).outcomeSet!.heldContinuation).toBeUndefined()
  })

  it('hands "needs changes" to the agent once, then asks the same person again on a new version', async () => {
    const { h, world, kept } = await started('feedback')
    // Why read, not assumed: the host mints the request key when it saves the rule.
    const firstKey = world.sent[0]!.operationId
    world.reply('hth_1', 'hrv_1', 'request_changes', 'Tighten the intro.')
    await ticks(h, 3)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Tighten the intro.')
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(reading(h).phase).toBe('active')

    // A restart: a new runtime and host read the same profile. The notes are not sent again.
    await h.stop()
    const restarted = completionHarness(h.workspace)
    harnesses.push(restarted)
    kept.attach(restarted)
    await ticks(restarted, 2)
    expect(pane.sent).toHaveLength(1)
    expect(upNextReviewReplies(run(restarted), 'review', restarted.clock.now)).toMatchObject({
      fixing: true,
      approved: 0,
      changes: [{ employeeId: 'emp_uma', round: 1, note: 'Tighten the intro.' }]
    })

    // The agent's turn ends: the same person is asked again, round 2, under a fresh key.
    pane.version = 'turn-2'
    await ticks(restarted, 2)
    const step = run(restarted).steps[0] as SessionChainHandoffStep
    const person = step.handoff.recipients[0]!
    expect(step.handoff.reask).toBe(true)
    expect(person).toMatchObject({ round: 2, delivery: 'sent' })
    expect(person.operationId).not.toBe(firstKey)
    expect(world.sent.map((input) => input.operationId)).toEqual([firstKey, person.operationId])
    expect(reading(restarted)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans' })
    expect(pane.sent).toHaveLength(1)

    // Their OK on the new version is what opens the gate.
    world.reply(person.threadId!, 'hrv_2', 'approve')
    await ticks(restarted, 2)
    expect(upNextReviewSettled(run(restarted), 'review')).toBe(true)
    expect(run(restarted).outcomeSet!.completion).toBeUndefined()
    expect(reading(restarted).phase).toBe('active')
  })

  it('seals a Hand off on its verified delivery, even with a stray draft naming its step', async () => {
    const { h, world } = await started('ownership-transfer')
    expect(world.sent).toHaveLength(1)
    await ticks(h, 2)
    expect(run(h).state).toBe('done')
    expect(run(h).outcomeSet!.completion).toBeDefined()
    expect(run(h).outcomeSet!.heldContinuation).toBeUndefined()
  })
})

describe('a Review with nothing held behind it (the last block), on the real host', () => {
  it('is never finished by "needs changes": the agent fixes it once, the same person is asked again, and their OK seals it', async () => {
    const { h, world } = await started('feedback', null)
    const firstKey = world.sent[0]!.operationId
    world.reply('hth_1', 'hrv_1', 'request_changes', 'Tighten the intro.')
    await ticks(h, 3)
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(run(h).state).toBe('waiting')
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Tighten the intro.')
    expect(reading(h)).toMatchObject({ phase: 'active', attention: [] })

    // The agent's turn ends: the same person is asked again, round 2, under a fresh key.
    pane.version = 'turn-2'
    await ticks(h, 2)
    const step = run(h).steps[0] as SessionChainHandoffStep
    const person = step.handoff.recipients[0]!
    expect(step.handoff.reask).toBe(true)
    expect(person).toMatchObject({ round: 2, delivery: 'sent' })
    expect(person.operationId).not.toBe(firstKey)
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(reading(h)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans', attention: [] })
    expect(pane.sent).toHaveLength(1)

    // Their OK on the new version finishes the run through the ordinary seal and disposition.
    world.reply(person.threadId!, 'hrv_2', 'approve')
    await ticks(h, 2)
    const chain = run(h)
    expect(chain.state).toBe('done')
    expect(chain.outcomeSet!.completion).toBeDefined()
    expect(chain.outcomeSet!.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
    expect(chain.outcomeSet!.heldContinuation).toBeUndefined()
    expect(reading(h).phase).toBe('completed')
    expect(pane.sent).toHaveLength(1)
  })

  it('stays held while 1 of 2 said OK, and hands over only the notes that asked for changes', async () => {
    const { h, world } = await started('feedback', null, [UMA, IRIS])
    expect(world.sent).toHaveLength(2)
    const thread = (employeeId: string): string =>
      (run(h).steps[0] as SessionChainHandoffStep).handoff.recipients.find(
        (person) => person.employeeId === employeeId
      )!.threadId!
    world.reply(thread('emp_uma'), 'hrv_1', 'approve')
    await ticks(h, 2)
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(reading(h)).toMatchObject({ phase: 'waiting', attention: [] })

    world.reply(thread('emp_iris'), 'hrv_2', 'request_changes', 'Shorter, please.')
    await ticks(h, 3)
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(run(h).state).toBe('waiting')
    expect(upNextReviewReplies(run(h), 'review', h.clock.now)).toMatchObject({
      replied: 2,
      approved: 1,
      total: 2
    })
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Iris Allen asked for changes (round 1):')
    expect(pane.sent[0]).not.toContain('Uma Evans asked')
    expect(reading(h)).toMatchObject({ phase: 'active', attention: [] })
  })

  it('is not finished by a reply on the thread that is neither "Looks good" nor "Needs changes"', async () => {
    const { h, world } = await started('feedback', null)
    world.comment('hth_1', 'Quick question before I look.')
    await ticks(h, 3)
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(run(h).state).toBe('waiting')
    expect(reading(h)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans', attention: [] })
    expect(pane.sent).toEqual([])
  })

  it('leaves a run an older build sealed on "needs changes" exactly as it was', async () => {
    const { h, world } = await started('feedback', null)
    world.reply('hth_1', 'hrv_1', 'request_changes', 'Tighten the intro.')
    // What a build before this rule wrote on that reply: the answer recorded, the run sealed.
    const { error: _diagnostic, ...chain } = run(h)
    const outcome = chain.outcomeSet!.outcomes[0]!
    const feedback = outcome.conditions.find((condition) => condition.id === 'feedback')!
    const receipt = 'handoff-review:hth_1:hrv_1:request_changes'
    const { heldContinuation: _stamp, ...answered } = recordSessionOutcomeEvidence(
      chain.outcomeSet!,
      sessionOutcomeVerifiedEvidence(outcome, feedback, receipt, h.clock.now)
    )
    const settled = (answered.attention ?? []).map((entry) =>
      entry.state === 'open'
        ? {
            ...entry,
            state: 'withdrawn' as const,
            resolvedAt: h.clock.now,
            resolution: 'The run moved on.'
          }
        : entry
    )
    const sealed = h.runtime.replaceSessionChainOutcomesAndFlush(
      {
        ...chain,
        state: 'done',
        outcomeSet: sealSessionRunCompletion(
          { ...answered, attention: settled },
          { now: h.clock.now, operationId: 'op_legacy' }
        )
      },
      chain.outcomeSet!.revision
    )

    await ticks(h, 3)
    expect(run(h).state).toBe('done')
    expect(run(h).outcomeSet).toEqual(sealed.outcomeSet)
    expect(run(h).steps).toEqual(sealed.steps)
    // Nobody is asked again, and the agent is handed nothing.
    expect(world.sent).toHaveLength(1)
    expect(pane.sent).toEqual([])
    const chains = h.runtime.listSessionChains()
    expect(
      auditSessionRuns(chains, h.clock.now, (entry) =>
        upNextHeldContinuation(h.runtime, entry, chains)
      )
    ).toEqual([])
  })
})

/** The stages of the four-block flow; the agent runs each to its end (`finishStage`). */
const DRAFT: SessionChainStep = {
  id: 'draft',
  outcomeId: 'delivery',
  agent: 'claude',
  prompt: 'Draft the intro.',
  status: 'queued'
}
const IMPROVE: SessionChainStep = { ...DRAFT, id: 'improve', prompt: 'Fix what Uma found.' }

/**
 * What the pre-tick's release of Improve and Review 2 writes once Uma approved Review 1
 * (`resumeUpNextContinuations` → `upNextCommitDrafts`): an APPEND to the same run through the
 * host's own commit door — the same Outcome, so the receipts it earned stand, plus Improve and a
 * second ask of Uma as a step of its own (`asksPeopleAgain`) — after which the released blocks
 * leave the draft store, or what was composed behind Review 2 waits on it. The agent runs Improve.
 */
async function release(
  h: CompletionHarness,
  kept: ReturnType<typeof stores>,
  heldBehindSecond: boolean
): Promise<void> {
  const chain = run(h)
  const outcome = chain.outcomeSet!.outcomes[0]!
  await h.service.commit(
    { ...chain, steps: [...chain.steps, IMPROVE, personStep('feedback', [UMA], 'review_2')] },
    {
      source: 'user',
      expectedRevision: chain.outcomeSet!.revision,
      outcomes: [
        {
          ...sessionOutcomeDefinition(outcome),
          stepIds: [...(outcome.stepIds ?? []), 'improve', 'review_2']
        }
      ]
    }
  )
  kept.hold(heldBehindSecond ? 'review_2' : null)
  finishStage(h, 'improve')
}

const ask = (h: CompletionHarness, stepId: string): SessionChainHandoffStep =>
  run(h).steps.find((step) => step.id === stepId) as SessionChainHandoffStep

/**
 * Draft → Review (Uma) → Improve → Review (Uma), both ticked: Uma approved the first, Improve and
 * Review 2 were released into the same run, and Review 2 reached him on a thread of its own.
 */
async function secondAskDelivered(heldBehindSecond = false) {
  const { h, world, kept } = await started('feedback', 'review', [UMA], [DRAFT])
  expect(world.sent).toHaveLength(1)
  world.reply('hth_1', 'hrv_1', 'approve')
  await ticks(h, 2)
  expect(upNextReviewSettled(run(h), 'review')).toBe(true)
  expect(run(h).outcomeSet!.completion).toBeUndefined()

  const revision = run(h).outcomeSet!.outcomes[0]!.revision
  await release(h, kept, heldBehindSecond)
  // Same Outcome, same revision; the answer to the FIRST ask is history, not the second's answer.
  expect(run(h).outcomeSet!.outcomes[0]!.revision).toBe(revision)
  expect(run(h).outcomeSet!.evidenceHistory?.map((entry) => entry.receipt)).toContain(
    'handoff-review:hth_1:hrv_1:approve'
  )
  expect(upNextReviewReplies(run(h), 'review_2', h.clock.now)).toMatchObject({
    replied: 0,
    total: 1
  })

  await ticks(h, 3)
  const person = ask(h, 'review_2').handoff.recipients[0]!
  expect(person).toMatchObject({ employeeId: 'emp_uma', delivery: 'sent' })
  expect(person.threadId).toBeDefined()
  expect(person.threadId).not.toBe('hth_1')
  expect(world.sent).toHaveLength(2)
  // The first answer finishes nothing: the run waits on Uma, and Review 2 is its one gate.
  expect(upNextReviewSettled(run(h), 'review_2')).toBe(false)
  expect(run(h).outcomeSet!.completion).toBeUndefined()
  expect(run(h).outcomeSet!.heldContinuation).toMatchObject({ reviewStepIds: ['review_2'] })
  expect(reading(h)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans', attention: [] })
  return { h, world, thread: person.threadId! }
}

describe('a second Review of the same person, released after the first, on the real host', () => {
  it('reads their answer on the second ask, and seals Completed on their OK to it', async () => {
    const { h, world, thread } = await secondAskDelivered()
    world.reply(thread, 'hrv_2', 'approve')
    await ticks(h, 2)
    const chain = run(h)
    expect(upNextReviewSettled(chain, 'review_2')).toBe(true)
    expect(chain.state).toBe('done')
    expect(chain.outcomeSet!.completion).toBeDefined()
    expect(chain.outcomeSet!.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
    expect(chain.outcomeSet!.heldContinuation).toBeUndefined()
    expect(reading(h).phase).toBe('completed')
    expect(pane.sent).toEqual([])
  })

  it('hands "needs changes" on the second ask to the agent once, and asks Uma again there', async () => {
    const { h, world, thread } = await secondAskDelivered()
    const [firstKey, secondKey] = world.sent.map((input) => input.operationId)
    world.reply(thread, 'hrv_2', 'request_changes', 'Shorter, please.')
    await ticks(h, 3)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('Uma Evans asked for changes (round 1):')
    expect(pane.sent[0]).toContain('Shorter, please.')
    expect(run(h).outcomeSet!.heldContinuation!.fixes).toMatchObject([
      { stepId: 'review_2', employeeId: 'emp_uma', round: 1, note: 'Shorter, please.' }
    ])
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(reading(h)).toMatchObject({ phase: 'active', attention: [] })

    // The agent's turn ends: Uma is asked again on Review 2 (round 2); the first ask is untouched.
    pane.version = 'turn-2'
    await ticks(h, 2)
    const second = ask(h, 'review_2')
    const person = second.handoff.recipients[0]!
    expect(second.handoff.reask).toBe(true)
    expect(person).toMatchObject({ employeeId: 'emp_uma', round: 2, delivery: 'sent' })
    expect(person.operationId).not.toBe(secondKey)
    expect(world.sent.map((input) => input.operationId)).toEqual([
      firstKey,
      secondKey,
      person.operationId
    ])
    const first = ask(h, 'review')
    expect(first.handoff.reask).toBeUndefined()
    expect(first.handoff.recipients[0]).toMatchObject({ threadId: 'hth_1', operationId: firstKey })
    expect(first.handoff.recipients[0]!.round).toBeUndefined()
    expect(reading(h)).toMatchObject({ phase: 'waiting', wake: 'Uma Evans', attention: [] })
    expect(pane.sent).toHaveLength(1)

    // Their OK on the fixed version is what finishes the run.
    world.reply(person.threadId!, 'hrv_3', 'approve')
    await ticks(h, 2)
    expect(run(h).state).toBe('done')
    expect(run(h).outcomeSet!.completion).toBeDefined()
    expect(pane.sent).toHaveLength(1)
  })

  it('keeps work composed behind the second ask waiting for Uma’s answer to THAT ask', async () => {
    const { h, world, thread } = await secondAskDelivered(true)
    world.reply(thread, 'hrv_2', 'approve')
    await ticks(h, 2)
    expect(upNextReviewSettled(run(h), 'review_2')).toBe(true)
    // Released by the pre-tick from here; the run is not over while it waits.
    expect(run(h).outcomeSet!.completion).toBeUndefined()
    expect(run(h).outcomeSet!.heldContinuation).toMatchObject({ reviewStepIds: ['review_2'] })
    expect(reading(h)).toMatchObject({ phase: 'active', attention: [] })
  })
})
