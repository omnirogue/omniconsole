/**
 * Removing and moving blocks that are already QUEUED — the plan's own re-author.
 *
 * Three things the view promises and the plan engine has to keep: a person nobody has been
 * sent to yet can be taken off the chain (their id is a step, not a plan node, which used to
 * make the engine answer "that block is no longer in Up next"); moving a person is impossible
 * and says so, because the people ARE the end of the track; and two stages that swap places
 * swap their wiring with them, or the commit is refused for reading work that no longer runs
 * first.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const readiness = vi.hoisted(() => ({ ready: true }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: readiness.ready,
    // `free` is the reading the Now row and the queue drain use; a stub that only knows
    // whether a turn finished answers both the same way (`conversation-readiness.ts`).
    free: readiness.ready,
    unverifiable: false
  })
}))

vi.mock('./conversation-delivery', () => ({
  deliverToConversation: async (): Promise<{ door: 'pty'; deliveredAt: number }> => ({
    door: 'pty',
    deliveredAt: 99
  })
}))

import { isSessionChainAgentStep } from '../../shared/session-chain-types'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextBlock,
  type UpNextView
} from '../../shared/up-next-types'
import { conversationId, harness, type UpNextHarness } from './rpc/methods/up-next-harness'

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const append = (host: UpNextHarness, draft: unknown): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft })

const commit = (host: UpNextHarness): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.commit, { conversationId })

const stage = (instruction: string): unknown => ({
  kind: 'agent',
  template: 'improve',
  instruction
})

const person = (relationship: 'review' | 'handoff'): unknown => ({
  kind: 'person',
  relationship,
  people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
})

/** A queued stage and a queued person, as one commit of one plan. */
async function queued(
  host: UpNextHarness,
  relationship: 'review' | 'handoff'
): Promise<UpNextView> {
  readiness.ready = true
  await append(host, stage('Sign the receipts.'))
  await append(host, person(relationship))
  return (await commit(host)).view
}

describe('removing a queued person', () => {
  it('takes a review nobody has answered off the chain, as the next plan version', async () => {
    const host = harness()
    const view = await queued(host, 'review')
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'queued'],
      ['person', 'queued']
    ])
    const reviewer = view.blocks[1]!
    expect(reviewer.id.startsWith('step:')).toBe(true)
    expect(reviewer.locked).toBe(false)
    expect(host.chains()[0]!.planVersion).toBe(1)

    const after = (await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: reviewer.id }))
      .view

    // The person is off the chain, as the next version of the same pursuit.
    expect(after.blocks.some((block) => block.kind === 'person')).toBe(false)
    expect(host.commits).toHaveLength(2)
    expect(host.chains()[0]!.planVersion).toBe(2)
    // The obligation went with them: nothing is waiting for a reply that is no longer asked.
    expect(
      host.commits[1]!.outcomes[0]!.conditions.map((condition) => condition.recipientId)
    ).toEqual([undefined])
    expect(after.canAdd.person).toBe(true)
    // What the retired version's unfinished stage becomes is the plan-version rule's own
    // business (`markSupersededPlanSteps`), not this door's, and is asserted nowhere here.
  })

  it('takes a handoff off the chain the same way, and the track continues', async () => {
    const host = harness()
    const view = await queued(host, 'handoff')
    const recipient = view.blocks[1]!
    expect(recipient.kind === 'person' && recipient.relationship).toBe('handoff')
    // A handoff ends the track, which is why removing it is the only way to add anything.
    expect(view.canAdd.agent).toBe(false)

    const after = (await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: recipient.id }))
      .view

    expect(after.blocks.some((block) => block.kind === 'person')).toBe(false)
    expect(after.canAdd.agent).toBe(true)
    expect(host.commits).toHaveLength(2)
  })
})

describe('moving a queued person', () => {
  it('refuses a handoff, because the track really does end there', async () => {
    const host = harness()
    const view = await queued(host, 'handoff')
    const recipient = view.blocks[1]!

    await expect(
      host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: recipient.id, direction: -1 })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.capIsTerminal)
    expect(host.commits).toHaveLength(1)
    expect((await list(host)).blocks.map((block) => block.kind)).toEqual(['agent', 'person'])
  })

  it('refuses to move a review DOWN: there is nothing below the end of the plan', async () => {
    const host = harness()
    const view = await queued(host, 'review')

    await expect(
      host.call(UP_NEXT_RPC.reorder, {
        conversationId,
        blockId: view.blocks[1]!.id,
        direction: 1
      })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    expect(host.commits).toHaveLength(1)
  })

  /**
   * A queued Review IS reorderable — the renderer draws no stop cap on it and the spec says
   * the chain continues after it — and the engine refused every attempt as terminal. It moves
   * earlier the only way this model can say it: the stage above becomes work HELD behind the
   * review, which the host commits as the next plan version when the reviewers reply.
   *
   * Asserted on the commit the engine issued rather than on the view, on purpose: the view
   * after a plan-version bump depends on the retirement site that honours `drawsSteps`
   * (`session-outcome-commit.ts` → `markSupersededPlanSteps`), and this harness's outcome
   * service is a stub that does not model it — every version bump empties its view. What
   * `drawsSteps` says IS the order: the plan keeps stage 1 and the people, and the stage the
   * review moved past is not drawn by it.
   */
  it('moves earlier by holding the stage above it behind the review', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage('Sign the receipts.'))
    await append(host, stage('Then check the ledger.'))
    await append(host, person('review'))
    const view = (await commit(host)).view
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'queued'],
      ['agent', 'queued'],
      ['person', 'queued']
    ])
    const [first, second, reviewer] = [view.blocks[0]!, view.blocks[1]!, view.blocks[2]!]
    if (reviewer.kind !== 'person' || !reviewer.stepId) {
      throw new Error('the commit compiled no review step')
    }
    const stepOf = (block: UpNextBlock): string =>
      block.id.slice(`${UP_NEXT_BLOCK_ID.planNode}`.length)

    await host.call(UP_NEXT_RPC.reorder, {
      conversationId,
      blockId: reviewer.id,
      direction: -1
    })

    expect(host.commits).toHaveLength(2)
    expect(host.chains()[0]!.planVersion).toBe(2)
    const drawn = host.commits[1]!.drawsSteps ?? []
    // Stage 1 and the people are what the new plan draws; the stage the review passed is not.
    expect(drawn).toContain(reviewer.stepId)
    expect(drawn.some((id) => id.includes(stepOf(first)))).toBe(true)
    expect(drawn.some((id) => id.includes(stepOf(second)))).toBe(false)
    // It is not lost: it is the block those people's reply releases, in Up next, still the
    // person's to edit or remove — and `discard drafts` does not take it.
    const held = host.drafts()!.entries
    expect(held.map((entry) => entry.held?.reviewStepId)).toEqual([reviewer.stepId])
    expect(held[0]!.input).toMatchObject({ kind: 'agent', instruction: 'Then check the ledger.' })
    const kept = (await host.call(UP_NEXT_RPC.discardDrafts, { conversationId })).view
    expect(kept.blocks.some((block) => block.id === held[0]!.id)).toBe(true)
  })
})

describe('moving a queued stage', () => {
  it('re-wires what each stage reads, so the new order is a plan that validates', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage('Sign the receipts.'))
    await append(host, stage('Then check the ledger.'))
    const view = (await commit(host)).view

    const [first, second] = [view.blocks[0]!, view.blocks[1]!]
    expect(view.blocks.map((block) => block.kind)).toEqual(['agent', 'agent'])
    // The second stage reads the first: that edge is what a naive swap left behind, and the
    // commit was then refused with `reads-from-not-earlier`.
    expect(second.kind === 'agent' && second.advanced.readsFrom).toEqual([first.id])

    const after = (
      await host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: second.id, direction: -1 })
    ).view

    expect(after.blocks.map((block) => block.id)).toEqual([second.id, first.id])
    expect(host.commits).toHaveLength(2)
    const moved = after.blocks[0]!
    const following = after.blocks[1]!
    expect(moved.kind === 'agent' && moved.advanced.readsFrom).toBeUndefined()
    expect(following.kind === 'agent' && following.advanced.readsFrom).toEqual([second.id])
  })
})

describe('moving a queued Verify', () => {
  it('keeps the verdict over its Done When entries, so the new order commits', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage('Sign the receipts.'))
    await append(host, {
      kind: 'agent',
      template: 'verify',
      instruction: 'Check every Done When.'
    })
    const view = (await commit(host)).view
    const [improve, verify] = [view.blocks[0]!, view.blocks[1]!]
    const over = (): string[] | undefined =>
      host
        .chains()[0]!
        .steps.filter(isSessionChainAgentStep)
        .find((step) => step.presetId === 'verify')?.verdict?.over
    const doneWhen = over()
    // A verify's `over` names DONE WHEN entries, not nodes — which is exactly why the
    // re-wiring may not touch it.
    expect(doneWhen?.length).toBeGreaterThan(0)
    expect(host.commits[0]!.outcomes[0]!.conditions.map((condition) => condition.id)).toEqual(
      expect.arrayContaining(doneWhen!)
    )

    const after = (
      await host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: verify.id, direction: -1 })
    ).view

    expect(after.blocks.map((block) => block.id)).toEqual([verify.id, improve.id])
    expect(host.commits).toHaveLength(2)
    expect(over()).toEqual(doneWhen)

    // And back down again: the same rule holds when the gate is re-wired onto a predecessor.
    const back = (
      await host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: verify.id, direction: 1 })
    ).view
    expect(back.blocks.map((block) => block.id)).toEqual([improve.id, verify.id])
    expect(host.commits).toHaveLength(3)
    expect(over()).toEqual(doneWhen)
  })
})
