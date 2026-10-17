/**
 * A Person block's optional due date, through the real draft store and the real `commitWorkPlan`
 * lowering: what the person chose on Hand off or Review is the `dueAt` the handoff rule carries
 * to the hub, offset kept and without fractional seconds, and nothing when none was chosen.
 * A due changed to a moment already past is refused; the block never carries a communication type.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: true, free: true, unverifiable: false })
}))
vi.mock('../../conversation-delivery', () => ({
  deliverToConversation: async (): Promise<{ door: 'pty'; deliveredAt: number }> => ({
    door: 'pty',
    deliveredAt: 99
  })
}))

import type { SessionChainHandoffStep } from '../../../../shared/session-follow-up-rule'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextPersonBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { conversationId, harness, rowKey, type UpNextHarness } from './up-next-harness'

const DAY_END = '2099-09-20T23:59:59-04:00'
const TIMED = '2099-09-20T15:30:00+02:00'
const PAST = '2020-01-01T23:59:59+00:00'
/** Offset and whole seconds only: the shape the relay's due_at pattern accepts. */
const WIRE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

const stage = { kind: 'agent', template: 'improve', instruction: 'Sign the receipts.' }
const RECEIVE = { files: true, transcript: false, createTaskCard: false }

function person(relationship: 'handoff' | 'review', receive: Record<string, unknown> = {}) {
  return {
    kind: 'person',
    relationship,
    people: [{ id: 'emp_1', name: 'Jordan Taylor' }],
    receive
  }
}

const personOf = (view: UpNextView): UpNextPersonBlock =>
  view.blocks.find((block): block is UpNextPersonBlock => block.kind === 'person')!

async function committed(
  relationship: 'handoff' | 'review',
  receive: Record<string, unknown>
): Promise<{ rule: SessionChainHandoffStep['handoff']; block: UpNextPersonBlock }> {
  const host = harness()
  await host.call(UP_NEXT_RPC.append, { conversationId, draft: stage })
  await host.call(UP_NEXT_RPC.append, { conversationId, draft: person(relationship, receive) })
  const { view } = await host.call(UP_NEXT_RPC.commit, { conversationId })
  const step = host
    .chains()[0]!
    .steps.find((entry): entry is SessionChainHandoffStep => entry.kind === 'handoff')!
  return { rule: step.handoff, block: personOf(view) }
}

const update = (host: UpNextHarness, blockId: string, receive: Record<string, unknown>) =>
  host.call(UP_NEXT_RPC.update, {
    conversationId,
    blockId,
    patch: { kind: 'person', receive }
  })

describe.each(['handoff', 'review'] as const)('a %s Person block', (relationship) => {
  it('carries a date-only or timed due onto the handoff rule as chosen', async () => {
    for (const dueAt of [DAY_END, TIMED]) {
      const { rule, block } = await committed(relationship, { dueAt })
      expect(rule.dueAt).toBe(dueAt)
      expect(rule.dueAt).toMatch(WIRE)
      // The queued row reads the due back from the rule, so its chip survives the commit.
      expect(block.receive.dueAt).toBe(dueAt)
    }
  })

  it('sends no due when none was chosen', async () => {
    const { rule, block } = await committed(relationship, { transcript: false })
    expect('dueAt' in rule).toBe(false)
    expect(block.receive.dueAt).toBeUndefined()
  })

  it('carries no communication type onto the rule', async () => {
    const { rule } = await committed(relationship, { dueAt: DAY_END })
    expect('communicationType' in rule).toBe(false)
  })
})

describe('changing the due of a composed Person block', () => {
  it('refuses a past due, keeps a later one, and clears it with the receive object', async () => {
    const host = harness()
    const appended = await host.call(UP_NEXT_RPC.append, {
      conversationId,
      draft: person('review')
    })
    const id = personOf(appended.view).id

    await expect(update(host, id, { ...RECEIVE, dueAt: PAST })).rejects.toThrow(
      UP_NEXT_REFUSAL_KEYS.dueInPast
    )
    expect(host.drafts()?.entries[0]?.input).not.toHaveProperty('receive.dueAt')

    const set = await update(host, id, { ...RECEIVE, dueAt: TIMED })
    expect(personOf(set.view).receive.dueAt).toBe(TIMED)

    const cleared = await update(host, id, RECEIVE)
    expect(personOf(cleared.view).receive.dueAt).toBeUndefined()
  })

  it('keeps a due that passed while the block waited when the note changes', async () => {
    const host = harness(
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
                  input: person('handoff', { dueAt: PAST }) as never
                }
              ]
            }
          }
        }
      }
    )
    const { view } = await update(host, 'draft:person', {
      ...RECEIVE,
      dueAt: PAST,
      note: 'Only the signing matters here.'
    })
    expect(personOf(view).receive).toMatchObject({
      dueAt: PAST,
      note: 'Only the signing matters here.'
    })
  })
})
