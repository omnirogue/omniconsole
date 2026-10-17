/**
 * What a WRITE to Up next really does — the doors a person presses that are not "queue this".
 *
 * Every case here is a rule the engine states and used to break: discarding drafts is not
 * allowed to take queued work with it, a Done nobody has executed can be taken back, a
 * finished session takes nothing at all, a move that cannot happen says so instead of
 * answering with an identical view, and the write that finishes a commit reaches disk with
 * the plan rather than a debounce later.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const readiness = vi.hoisted(() => ({ ready: true }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: readiness.ready,
    // `free` is the reading the Now row and the queue drain use; a stub that only knows
    // whether a turn finished answers both the same way (`conversation-readiness.ts`).
    free: readiness.ready,
    unverifiable: false
  })
}))

const door = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../../conversation-delivery', () => ({
  deliverToConversation: async (
    _runtime: unknown,
    _source: unknown,
    text: string
  ): Promise<{ door: 'pty'; deliveredAt: number }> => {
    door.sent.push(text)
    return { door: 'pty', deliveredAt: 99 }
  }
}))

import { scheduleSave } from '../../../persistence/loading-store/write-scheduling'
import { upNextHoldsContinuation } from '../../up-next-continuation'
import { isSessionChainAgentStep, type SessionChain } from '../../../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../../../shared/session-outcome-revise'
import {
  sessionOutcomeConditionKey,
  sessionOutcomeDefinition,
  type SessionOutcomeCondition,
  type SessionOutcomeSet
} from '../../../../shared/session-outcome-types'
import {
  UP_NEXT_DONE_BLOCK_ID,
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextView
} from '../../../../shared/up-next-types'
import { conversationId, harness, rowKey, type UpNextHarness } from './up-next-harness'

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const append = (host: UpNextHarness, draft: unknown): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft })

const stage = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'agent',
  template: 'improve',
  instruction: 'Improve the receipt signing.',
  ...over
})

const reviewer = {
  kind: 'person',
  relationship: 'review',
  people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
}

const commit = (host: UpNextHarness): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.commit, { conversationId })

const remove = (host: UpNextHarness, blockId: string): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.remove, { conversationId, blockId })

const move = (host: UpNextHarness, blockId: string, direction: 1 | -1): Promise<unknown> =>
  host.call(UP_NEXT_RPC.reorder, { conversationId, blockId, direction })

/** A chain whose one Outcome is answered: the session is finished and Done has executed. */
function finishedChain(): SessionChain {
  const condition: SessionOutcomeCondition = { id: 'c1', kind: 'review', target: 'o1' }
  const set: SessionOutcomeSet = {
    schemaVersion: 1,
    revision: 1,
    sessionFinish: { action: 'end' },
    outcomes: [
      {
        id: 'o1',
        title: 'Receipts are signed',
        finish: 'my-review',
        dependsOn: [],
        conditions: [condition],
        actions: [],
        revision: 1,
        status: 'satisfied',
        evidence: [
          {
            id: 'ev_1',
            outcomeId: 'o1',
            conditionId: condition.id,
            outcomeRevision: 1,
            conditionKey: sessionOutcomeConditionKey(condition),
            kind: 'review',
            target: 'o1',
            receipt: 'user-review:emp_1',
            verifiedAt: 30,
            verifier: 'execution-host'
          }
        ]
      }
    ],
    removals: [],
    attempts: [],
    continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
    updatedAt: 40
  }
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: conversationId.paneKey,
    sourceRowKey: rowKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'done',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: set
  }
}

describe('discarding what was composed', () => {
  it('keeps the work a review is holding, and throws away only the drafts', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, reviewer)
    const held = (
      await append(host, stage({ instruction: 'Fix what they found.' }))
    ).view.blocks.at(-1)!
    const queued = (await commit(host)).view
    expect(queued.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'queued'],
      ['person', 'queued'],
      ['agent', 'waiting']
    ])

    const composed = (
      await append(host, stage({ instruction: 'And one more thing.' }))
    ).view.blocks.at(-1)!
    expect((await list(host)).draftCount).toBe(1)

    const after = (await host.call(UP_NEXT_RPC.discardDrafts, { conversationId })).view

    // The draft is gone; the block the reviewers are holding is still work.
    expect(after.blocks.some((block) => block.id === composed.id)).toBe(false)
    expect(after.draftCount).toBe(0)
    const waiting = after.blocks.find((block) => block.id === held.id)!
    expect([waiting.kind, waiting.state]).toEqual(['agent', 'waiting'])
    expect(waiting.heldFor).toMatchObject({ kind: 'review' })
    expect(host.drafts()?.entries.map((entry) => Boolean(entry.held))).toEqual([true])
  })
})

describe('taking Done back off the chain', () => {
  it('withdraws a Done nobody has executed, and lets work be added again', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'done', finish: 'close' })
    const queued = (await commit(host)).view

    expect(queued.blocks.map((block) => block.kind)).toEqual(['agent', 'done'])
    // The contradiction this fixes: the add gate says "remove Done to add more".
    expect(queued.canAdd.agent).toBe(false)
    expect(queued.canAdd.reasons.agent).toBe(UP_NEXT_REASON_KEYS.doneLastRemoveToAdd)
    expect(host.commits.at(-1)!.sessionFinish).toEqual({ action: 'end' })

    const after = (await remove(host, UP_NEXT_DONE_BLOCK_ID)).view

    expect(after.blocks.map((block) => block.kind)).toEqual(['agent'])
    expect(after.canAdd.agent).toBe(true)
    // Withdrawn as itself: an explicit clear of the finish intent, with the plan untouched.
    expect(host.commits.at(-1)!.clearSessionFinish).toBe(true)
    expect(host.commits.at(-1)!.sessionFinish).toBeUndefined()
    expect(host.chains()[0]!.outcomeSet?.sessionFinish).toBeUndefined()
    expect(host.chains()[0]!.steps.filter(isSessionChainAgentStep)).toHaveLength(1)
  })

  it('refuses a Done that has already finished the session', async () => {
    readiness.ready = true
    const host = harness({}, { chains: [finishedChain()] })
    const view = await list(host)
    // Finished is `completed`; `closed` is only ever a close that a window REPORTED applied.
    expect(view.header.state).toBe('completed')
    const done = view.blocks.find((block) => block.kind === 'done')!
    expect([done.state, done.locked]).toEqual(['done', true])

    await expect(remove(host, done.id)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.blockRunning)
    expect(host.commits).toHaveLength(0)
  })

  it('clears the finish in the reviser only when the commit says so', () => {
    const previous = finishedChain().outcomeSet!
    const owner = previous.continuation
    const outcomes = previous.outcomes.map(sessionOutcomeDefinition)
    const carried = reviseSessionOutcomeSet(
      previous,
      { expectedRevision: 1, outcomes, source: 'user' },
      owner,
      50
    )
    expect(carried.sessionFinish).toEqual({ action: 'end' })
    const cleared = reviseSessionOutcomeSet(
      previous,
      { expectedRevision: 1, outcomes, source: 'user', clearSessionFinish: true },
      owner,
      50
    )
    expect(cleared.sessionFinish).toBeUndefined()
  })
})

describe('a finished session takes nothing at all', () => {
  it('refuses a prompt at the head of a finished run, as it refuses one at the end', async () => {
    readiness.ready = true
    const host = harness({}, { chains: [finishedChain()] })
    const view = await list(host)
    // The run is finished although no window closed its session: that alone takes nothing more.
    expect(view.header.state).toBe('completed')
    expect(view.canAdd.reasons.prompt).toBe(UP_NEXT_REASON_KEYS.sessionClosed)

    await expect(
      host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'One more thing.' },
        position: 'head'
      })
    ).rejects.toThrow(UP_NEXT_REASON_KEYS.sessionClosed)
    await expect(append(host, { kind: 'prompt', text: 'One more thing.' })).rejects.toThrow(
      UP_NEXT_REASON_KEYS.sessionClosed
    )
    expect(host.drafts()).toBeNull()
  })
})

describe('moving a row that is already queued', () => {
  it('refuses to move the last queued prompt past the plan', async () => {
    readiness.ready = false
    const host = harness()
    const prompt = (
      await append(host, { kind: 'prompt', text: 'After you finish.' })
    ).view.blocks.at(-1)!
    await commit(host)
    await append(host, stage())
    const queued = (await commit(host)).view
    const waiting = queued.blocks.find((block) => block.id.startsWith('pq:'))!
    expect(queued.blocks.map((block) => block.kind)).toEqual(['prompt', 'agent'])

    // The queue only reorders among itself, so this move could never happen; saying nothing
    // and returning the same view is what made the ↓ control a lie.
    await expect(move(host, waiting.id, 1)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    expect((await list(host)).blocks.map((block) => block.kind)).toEqual(['prompt', 'agent'])
    expect(prompt.kind).toBe('prompt')
  })

  it('moves a prompt nested under a stage, and refuses at the stage boundary', async () => {
    readiness.ready = true
    door.sent = []
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'prompt', text: 'First, the receipt test.' })
    await append(host, { kind: 'prompt', text: 'Then the ledger.' })
    const queued = (await commit(host)).view
    expect(queued.blocks.map((block) => [block.kind, block.number])).toEqual([
      ['agent', '1'],
      ['prompt', '1.1'],
      ['prompt', '1.2']
    ])
    const [first, second] = [queued.blocks[1]!, queued.blocks[2]!]

    const moved = (await host.call(UP_NEXT_RPC.reorder, {
      conversationId,
      blockId: second.id,
      direction: -1
    })) as { view: UpNextView }

    expect(moved.view.blocks.map((block) => block.id)).toEqual([
      queued.blocks[0]!.id,
      second.id,
      first.id
    ])
    const seat = host.chains()[0]!.steps.find(isSessionChainAgentStep)!
    expect(seat.prompts?.map((entry) => entry.text)).toEqual([
      'Then the ledger.',
      'First, the receipt test.'
    ])

    // The stage row above is not a prompt of this stage, and there is nothing below.
    await expect(move(host, second.id, -1)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    await expect(move(host, first.id, 1)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    expect(door.sent).toEqual([])
  })
})

describe('the write that finishes a commit', () => {
  it('puts the drafts it queued on disk with the plan, not on a debounce', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage())
    await append(host, reviewer)
    await append(host, stage({ instruction: 'Fix what they found.' }))
    const scheduled = vi.mocked(scheduleSave).mock.calls.length

    await commit(host)

    // One durable write, and the debounce was never asked: the plan and what became of the
    // drafts are the same moment on disk.
    expect(host.flushed()).toBe(1)
    expect(vi.mocked(scheduleSave).mock.calls.length).toBe(scheduled)
    const record = host.state.upNextDrafts?.[rowKey]
    expect(record?.entries.map((entry) => Boolean(entry.held))).toEqual([true])
    expect(record?.entries[0]?.held?.reviewStepId).toBe(
      host.chains()[0]!.steps.find((step) => step.kind === 'handoff')!.id
    )
    expect(host.chains()[0]!.steps.filter(isSessionChainAgentStep)).toHaveLength(1)
  })
})

describe('naming the agent a stage runs on', () => {
  it('refuses an Agent block when the host cannot name the conversation’s agent', async () => {
    readiness.ready = true
    // What every structured (chat) session used to look like: no PTY, so no agent.
    // `up-next-conversation-agent.test.ts` owns the reading that ends this refusal.
    const host = harness({}, { agent: null })
    await append(host, stage())

    await expect(commit(host)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.needsAgent)
    expect(host.commits).toHaveLength(0)
    expect(host.drafts()?.entries).toHaveLength(1)
  })
})

describe('moving a composed row that has nowhere higher to go', () => {
  it('refuses a stage draft whose neighbour above is the first queued block', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage())
    const queued = (await commit(host)).view
    const first = queued.blocks[0]!
    expect([first.kind, first.state, first.locked]).toEqual(['agent', 'queued', false])

    const composed = (
      await host.call(UP_NEXT_RPC.configureAfter, { conversationId, blockId: first.id })
    ).view
    const draft = composed.blocks.at(-1)!
    expect(composed.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'queued'],
      ['agent', 'draft']
    ])

    // Only a PROMPT may be the next thing the current agent hears, so this row cannot rise
    // above the stage it was configured after: the move is refused rather than answered with
    // an identical view — the same honesty the prompt queue already owes (U-22).
    await expect(move(host, draft.id, -1)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    expect((await list(host)).blocks.map((block) => block.id)).toEqual([first.id, draft.id])
    expect(host.drafts()?.entries.map((entry) => entry.afterBlockId)).toEqual([first.id])
  })
})

describe('a prompt under a stage that runs on more than one seat', () => {
  const order = (host: UpNextHarness): string[][] =>
    host
      .chains()[0]!
      .steps.filter(isSessionChainAgentStep)
      .map((seat) => (seat.prompts ?? []).map((entry) => entry.text))

  it('moves and removes the row for EVERY seat of the stage', async () => {
    readiness.ready = true
    door.sent = []
    const host = harness()
    await append(host, stage({ shape: 'parallel', n: 2 }))
    await append(host, { kind: 'prompt', text: 'First, the receipt test.' })
    await append(host, { kind: 'prompt', text: 'Then the ledger.' })
    const queued = (await commit(host)).view
    expect(queued.blocks.map((block) => [block.kind, block.number])).toEqual([
      ['agent', '1'],
      ['prompt', '1.1'],
      ['prompt', '1.2']
    ])
    // The fan-out wrote the same two prompts to both seats: one instruction, written once.
    expect(order(host)).toEqual([
      ['First, the receipt test.', 'Then the ledger.'],
      ['First, the receipt test.', 'Then the ledger.']
    ])

    await host.call(UP_NEXT_RPC.reorder, {
      conversationId,
      blockId: queued.blocks[2]!.id,
      direction: -1
    })

    // The row is the whole stage's order. Moving it in the first seat only left the second
    // seat draining the order the panel had stopped showing.
    expect(order(host)).toEqual([
      ['Then the ledger.', 'First, the receipt test.'],
      ['Then the ledger.', 'First, the receipt test.']
    ])

    const moved = (await list(host)).blocks
    await remove(host, moved[1]!.id)

    expect(order(host)).toEqual([['First, the receipt test.'], ['First, the receipt test.']])
    expect(door.sent).toEqual([])
  })
})

describe('a commit whose second write never landed', () => {
  it('does not bring queued work back as a draft, and the host clears it', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage())
    const composed = host.drafts()!.entries
    const queued = (await commit(host)).view
    expect(queued.blocks.map((block) => [block.kind, block.state])).toEqual([['agent', 'queued']])
    expect(host.drafts()).toBeNull()

    // The crash window, as the evidence states it: the plan's own flush landed, the write that
    // clears what it queued did not, so disk holds the plan AND the drafts. Reconstructed
    // here — the process that dies between two flushes is exactly what cannot be scripted —
    // and it is the same state a `flushOrThrow` failure rolls back to.
    host.state.upNextDrafts![rowKey] = { subject: conversationId, entries: composed, updatedAt: 1 }

    const after = await list(host)

    // One row, not two: the chain says this stage was queued, so nothing offers to queue it
    // again — and `+ Agent` could not, because the plan refuses its duplicate node id.
    expect(after.blocks.map((block) => [block.kind, block.state])).toEqual([['agent', 'queued']])
    expect(after.draftCount).toBe(0)

    // And the host catches disk up on its own next pass, rather than leaving it to a person.
    expect(upNextHoldsContinuation(host.ctx.runtime as never)).toBe(true)
    await host.resume()

    expect(host.drafts()).toBeNull()
    expect(host.chains()[0]!.steps.filter(isSessionChainAgentStep)).toHaveLength(1)
  })
})

describe('a queued prompt that failed', () => {
  const failed = async (): Promise<UpNextHarness> => {
    const host = harness()
    const runtime = host.ctx.runtime as unknown as {
      enqueuePromptQueueEntry: (source: unknown, entry: unknown) => unknown
      settlePromptQueueEntry: (key: string, id: string, settlement: unknown) => unknown
    }
    runtime.enqueuePromptQueueEntry(conversationId, {
      id: 'e1',
      text: 'Research the code',
      createdAt: 1,
      state: 'queued'
    })
    runtime.enqueuePromptQueueEntry(conversationId, {
      id: 'e2',
      text: 'Now plan it',
      createdAt: 2,
      state: 'queued'
    })
    runtime.settlePromptQueueEntry(rowKey, 'e1', { state: 'failed', reason: 'gone' })
    return host
  }

  it('says why, and that the queue waits behind it', async () => {
    const host = await failed()
    expect((await list(host)).blocks.find((block) => block.id === 'pq:e1')).toMatchObject({
      state: 'failed',
      failureReason: 'gone',
      holdsQueue: true
    })
  })

  it('is queued again at the head of the queue', async () => {
    const host = await failed()
    const view = (await host.call(UP_NEXT_RPC.requeue, { conversationId, blockId: 'pq:e1' })).view
    const prompts = view.blocks.filter((block) => block.kind === 'prompt')
    expect(prompts.map((block) => [block.kind === 'prompt' && block.text, block.state])).toEqual([
      ['Research the code', 'queued'],
      ['Now plan it', 'queued']
    ])
    expect(prompts[0]!.id).not.toBe('pq:e1')
  })

  it('is dismissed through the ordinary remove', async () => {
    const host = await failed()
    const view = (await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: 'pq:e1' })).view
    expect(view.blocks.map((block) => block.id)).toEqual(['pq:e2'])
  })

  it('queues again only a queued prompt', async () => {
    const host = await failed()
    await expect(
      host.call(UP_NEXT_RPC.requeue, { conversationId, blockId: 'step:s1' })
    ).rejects.toThrow('Only a queued prompt can be queued again.')
  })
})
