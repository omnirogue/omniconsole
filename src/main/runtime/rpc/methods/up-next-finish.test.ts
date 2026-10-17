/**
 * Done on a conversation that never became a pursuit (U-49).
 *
 * No Outcome is manufactured to absorb the finish (frozen model, invariants 2 and 10), so the
 * host answers the commit with the CHOICE and the surface's own finish door carries it out. The
 * engine already refused to invent one; without the RPC answering with it, pressing Done on an
 * ordinary chat queued nothing, finished nothing, and said nothing.
 *
 * The transcript source is the other half of the same door: only the host can name where people
 * read this conversation, and a Person block that asked for the transcript reaches for it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: true, free: true, unverifiable: false })
}))
vi.mock('../../conversation-delivery', () => ({
  deliverToConversation: async () => ({ door: 'pty', deliveredAt: 99 })
}))
vi.mock('../../session-outcome-handoff', () => ({
  readSessionOutcomePrincipal: async () => 'company/person'
}))

import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'
import { UP_NEXT_RPC, type UpNextView } from '../../../../shared/up-next-types'
import { conversationId, harness, type UpNextHarness } from './up-next-harness'

type Committed = { view: UpNextView; finish?: SessionFinishChoice }

const append = (host: UpNextHarness, draft: unknown): Promise<unknown> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft })

const commit = (host: UpNextHarness): Promise<Committed> =>
  host.call(UP_NEXT_RPC.commit, { conversationId }) as Promise<Committed>

describe('a finish this host cannot record', () => {
  it('hands the choice back instead of manufacturing a pursuit for it', async () => {
    const host = harness()
    await append(host, { kind: 'done', finish: 'close' })

    const committed = await commit(host)

    expect(committed.finish).toEqual({ action: 'end' })
    // Nothing was invented to hold it: no commit, no chain, no Done block left behind.
    expect(host.commits).toEqual([])
    expect(host.chains()).toEqual([])
    expect(committed.view.blocks).toEqual([])
    expect(host.drafts()?.entries ?? []).toEqual([])
  })

  it('carries the folder a Save was filed under', async () => {
    const host = harness()
    await append(host, { kind: 'done', finish: 'save', folderId: 'saved-sessions' })

    expect((await commit(host)).finish).toEqual({
      action: 'save',
      folderId: 'saved-sessions'
    })
  })

  it('says nothing when the pursuit recorded the finish itself', async () => {
    const host = harness()
    await append(host, {
      kind: 'agent',
      template: 'improve',
      instruction: 'Improve the receipt signing.'
    })
    await append(host, { kind: 'done', finish: 'close' })

    const committed = await commit(host)

    expect(committed.finish).toBeUndefined()
    expect(host.commits.at(-1)!.sessionFinish).toEqual({ action: 'end' })
    expect(committed.view.blocks.map((block) => block.kind)).toEqual(['agent', 'done'])
  })
})

it('names where the people it finishes at can read this conversation', async () => {
  const host = harness()
  await append(host, {
    kind: 'person',
    relationship: 'review',
    people: [{ id: 'emp_1', name: 'Jordan Taylor' }],
    receive: { transcript: true }
  })

  await commit(host)

  const handoff = host
    .chains()
    .at(-1)!
    .steps.find((step) => step.kind === 'handoff')
  expect(handoff?.kind === 'handoff' && handoff.handoff.transcriptSource).toMatchObject({
    kind: 'provider',
    sessionId: 'session-1'
  })
})
