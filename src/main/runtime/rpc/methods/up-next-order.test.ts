/**
 * What a commit takes, and the order it keeps.
 *
 * Three rules the composer's own surface cannot prove on its own: a commit queues only the
 * blocks it was given (which is how `/next` queues itself without taking the blocks beside
 * it), a send that stops waiting leaves what follows it composed and never run, and a chain
 * is never queued in an order it did not show. The fourth is the one nobody sees: a prompt a
 * review is HOLDING has to survive the resume and reach its stage's own conversation.
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

import {
  isSessionChainAgentStep,
  type SessionChainAgentStep
} from '../../../../shared/session-chain-types'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextView
} from '../../../../shared/up-next-types'
import { upNextWontRun } from '../../../../shared/up-next-person-send'
import { drainUpNextStagePrompts } from '../../up-next-stage-prompts'
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

describe('queueing exactly what was named, in the order it was shown', () => {
  it('queues only the blocks a caller names and leaves the rest composed', async () => {
    readiness.ready = false
    door.sent = []
    const host = harness()
    await append(host, stage({ instruction: 'Later, once this one is done.' }))
    const composed = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'Answer this first.' },
        position: 'head'
      })
    ).view
    const head = composed.blocks.find((block) => block.kind === 'prompt')!

    const view = (await host.call(UP_NEXT_RPC.commit, { conversationId, blockIds: [head.id] })).view

    // The prompt is real work now; the stage the person is still writing is untouched.
    expect(host.queue()?.entries.map((entry) => [entry.text, entry.state])).toEqual([
      ['Answer this first.', 'queued']
    ])
    expect(host.commits).toHaveLength(0)
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['prompt', 'queued'],
      ['agent', 'draft']
    ])
    expect(host.drafts()?.entries.map((entry) => entry.input.kind)).toEqual(['agent'])
    // Naming a block that is no longer composed is a refusal, not a commit of everything.
    await expect(
      host.call(UP_NEXT_RPC.commit, { conversationId, blockIds: [head.id] })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  })

  it('refuses a named prompt whose own stage is not being queued with it', async () => {
    readiness.ready = false
    door.sent = []
    const host = harness()
    const composing = (await append(host, stage({ instruction: 'Sign the receipts.' }))).view
    const agent = composing.blocks[0]!
    const nested = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'And check the totals twice.', targetBlockId: agent.id }
      })
    ).view.blocks.find((block) => block.kind === 'prompt')!

    // The prompt belongs to a stage that does not exist yet: queueing it alone delivered it
    // nowhere, reported success and deleted it.
    await expect(
      host.call(UP_NEXT_RPC.commit, { conversationId, blockIds: [nested.id] })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.promptNeedsItsStage)
    expect(host.commits).toHaveLength(0)
    expect(door.sent).toEqual([])
    expect(host.drafts()?.entries.map((entry) => entry.input.kind)).toEqual(['agent', 'prompt'])

    // Named together, they queue: the stage is compiled and the prompt is attached to its seat.
    await host.call(UP_NEXT_RPC.commit, {
      conversationId,
      blockIds: [agent.id, nested.id]
    })
    expect(host.commits).toHaveLength(1)
    expect(host.drafts()?.entries ?? []).toEqual([])
    const seats = host.chains()[0]!.steps.filter(isSessionChainAgentStep)
    expect(seats.flatMap((step) => step.prompts?.map((prompt) => prompt.text) ?? [])).toEqual([
      'And check the totals twice.'
    ])
  })

  it('lets a send stop waiting while only composed blocks follow it, and marks them', async () => {
    readiness.ready = true
    const host = harness()
    const person = (await append(host, { kind: 'person', peopleIds: ['emp_1'] })).view.blocks[0]!
    await append(host, stage({ instruction: 'Fix what they found.' }))
    const handoff = {
      conversationId,
      blockId: person.id,
      patch: { kind: 'person', relationship: 'handoff' }
    }

    // Unticking "wait for their OK" ends the track at the send: what follows never runs.
    const view = (await host.call(UP_NEXT_RPC.update, handoff)).view
    expect(view.blocks[0]!.kind === 'person' && view.blocks[0]!.relationship).toBe('handoff')
    expect(upNextWontRun(view.blocks, 1)).toBe(true)
  })

  it('queues the chain in the order it showed, and refuses an order it cannot keep', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await host.call(UP_NEXT_RPC.commit, { conversationId })
    expect(host.chains()[0]!.steps.map((step) => step.kind ?? 'agent')).toEqual([
      'agent',
      'handoff'
    ])

    // The same two blocks the other way round cannot execute as shown — people are the
    // plan's finish, so the stage would run first. The hand off ends the track: it is queued
    // alone and the stage stays the person's draft, never quietly run before it.
    const inverted = harness(
      {},
      {
        state: {
          upNextDrafts: {
            [rowKey]: {
              subject: conversationId,
              updatedAt: 0,
              entries: [
                {
                  id: 'draft:person',
                  createdAt: 1,
                  input: {
                    kind: 'person',
                    relationship: 'handoff',
                    people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
                  }
                },
                {
                  id: 'draft:stage',
                  createdAt: 2,
                  input: {
                    kind: 'agent',
                    template: 'improve',
                    instruction: 'After they already own it.'
                  }
                }
              ]
            }
          }
        }
      }
    )
    expect((await list(inverted)).blocks.map((block) => block.kind)).toEqual(['person', 'agent'])
    await inverted.call(UP_NEXT_RPC.commit, { conversationId })
    expect(inverted.commits).toHaveLength(1)
    expect(inverted.chains()[0]!.steps.map((step) => step.kind ?? 'agent')).toEqual(['handoff'])
    expect(inverted.drafts()?.entries.map((entry) => entry.id)).toEqual(['draft:stage'])
  })

  it('delivers a prompt held under a stage behind a review once the review returns', async () => {
    readiness.ready = true
    door.sent = []
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    const held = (
      await append(host, stage({ template: 'improve', instruction: 'Fix what they found.' }))
    ).view.blocks.at(-1)!
    await append(host, { kind: 'prompt', text: 'Start with the receipt test.' })

    const queued = (await host.call(UP_NEXT_RPC.commit, { conversationId })).view
    const prompt = queued.blocks.at(-1)!
    expect([prompt.kind, prompt.state]).toEqual(['prompt', 'waiting'])
    expect(prompt.kind === 'prompt' && prompt.target).toEqual({ kind: 'stage', blockId: held.id })

    // The work queued with the review finishes, the reviewer replies, the host resumes.
    host.finishStage(host.chains()[0]!.steps.find((step) => step.kind !== 'handoff')!.id)
    host.reply('emp_1')
    await host.resume()

    const seat = host
      .chains()[0]!
      .steps.filter(isSessionChainAgentStep)
      .find((step) => step.stage?.id === `stage-${held.id}`)!
    expect(seat.prompts?.map((entry) => entry.text)).toEqual(['Start with the receipt test.'])
    // Nothing was left behind, and nothing went to the person's own agent instead.
    expect(host.drafts()).toBeNull()
    expect(host.queue()).toBeNull()

    // It reaches that seat's own conversation once it is idle, with its receipt.
    const chain = host.chains()[0]!
    const launched: SessionChainAgentStep = {
      ...seat,
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1'
    }
    host.service.save({
      ...chain,
      steps: chain.steps.map((step) => (step.id === seat.id ? launched : step))
    })
    await drainUpNextStagePrompts(host.ctx.runtime, { epoch: 'epoch-1' })

    expect(door.sent).toEqual(['Start with the receipt test.'])
    const delivered = host
      .chains()[0]!
      .steps.filter(isSessionChainAgentStep)
      .find((step) => step.id === seat.id)!
    expect(delivered.prompts?.map((entry) => [entry.state, entry.deliveryEpoch])).toEqual([
      ['delivered', 'epoch-1']
    ])
  })
})
