/**
 * "Send to a person", through the real draft store and the real `commitWorkPlan` lowering.
 *
 * The one checkbox maps onto the rule the engine already has — ticked is a review every named
 * person answers, unticked is a hand off — and every send carries everything, whatever an older
 * draft stored. The note the person typed reaches the people as their own words, distinct from
 * the title capture compares it with, and an empty note stays empty. A send that does not wait
 * commits alone: what was composed after it stays a draft that never runs from there.
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
import type { UpNextDraftEntry } from '../../../../shared/up-next-draft-schema'
import { upNextStepsAfter, upNextWontRun } from '../../../../shared/up-next-person-send'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextPersonBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { conversationId, harness, rowKey, type UpNextHarness } from './up-next-harness'

const DUE = '2099-09-20T23:59:59-04:00'
const UMA = { id: 'emp_uma', name: 'Uma Evans' }
const GAMMA = { id: 'emp_gamma', name: 'Jordan Taylor' }

const stage = (instruction = 'Sign the receipts.') => ({
  kind: 'agent',
  template: 'improve',
  instruction
})

const append = (host: UpNextHarness, draft: unknown, over: Record<string, unknown> = {}) =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft, ...over })

const commit = (host: UpNextHarness) => host.call(UP_NEXT_RPC.commit, { conversationId })

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

/** The draft store as an older build left it, written straight through the host's own door. */
const replaceDrafts = (host: UpNextHarness, entries: readonly UpNextDraftEntry[]): void =>
  (
    host.ctx.runtime as unknown as {
      replaceUpNextDrafts: (subject: unknown, next: readonly UpNextDraftEntry[]) => void
    }
  ).replaceUpNextDrafts(conversationId, entries)

const personOf = (view: UpNextView): UpNextPersonBlock =>
  view.blocks.find((block): block is UpNextPersonBlock => block.kind === 'person')!

const ruleOf = (host: UpNextHarness): SessionChainHandoffStep['handoff'] =>
  host.chains()[0]!.steps.find((step): step is SessionChainHandoffStep => step.kind === 'handoff')!
    .handoff

describe('the checkbox, as the rule it commits', () => {
  it('ticked asks every named person for their OK and holds the steps after it', async () => {
    const host = harness()
    await append(host, stage())
    // Nobody touched the box: a step follows it, so it waits by default.
    await append(host, {
      kind: 'person',
      people: [UMA, GAMMA],
      receive: { note: 'Check the totals.', dueAt: DUE }
    })
    const composed = (await append(host, stage('Fix what they found.'))).view
    expect(personOf(composed).relationship).toBeNull()

    await commit(host)

    const rule = ruleOf(host)
    expect(rule).toMatchObject({
      disposition: 'feedback',
      action: 'review',
      includeSummary: true,
      note: 'Check the totals.',
      dueAt: DUE
    })
    expect(rule.transcriptSource).toBeDefined()
    expect(rule.recipients.map((recipient) => recipient.employeeId)).toEqual([
      'emp_uma',
      'emp_gamma'
    ])
    // Every named person answers: one review condition each, so ALL must say OK.
    expect(
      host.commits[0]!.outcomes[0]!.conditions.filter(
        (condition) => condition.kind === 'review'
      ).map((condition) => condition.recipientId)
    ).toEqual(['emp_uma', 'emp_gamma'])
    // Their note is marked as their own words, so capture never reads it as "nothing authored".
    expect(rule.noteAuthored).toBe(true)
    // The step after it waits for their OK instead of being queued.
    expect(host.drafts()?.entries.map((entry) => [entry.input.kind, Boolean(entry.held)])).toEqual([
      ['agent', true]
    ])
  })

  it('unticked hands it over and still sends everything', async () => {
    const host = harness()
    await append(host, stage())
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [UMA],
      receive: { note: 'Yours now.' }
    })
    await commit(host)

    const rule = ruleOf(host)
    expect(rule).toMatchObject({
      disposition: 'ownership-transfer',
      action: 'edit',
      includeSummary: true,
      note: 'Yours now.'
    })
    expect(rule.transcriptSource).toBeDefined()
    expect('dueAt' in rule).toBe(false)
  })

  it('sends everything for an older draft that stored less, and keeps its choice', async () => {
    const host = harness(
      {},
      {
        state: {
          upNextDrafts: {
            [rowKey]: {
              subject: conversationId,
              updatedAt: 0,
              entries: [
                { id: 'draft:stage', createdAt: 1, input: stage() as never },
                {
                  id: 'draft:old',
                  createdAt: 2,
                  input: {
                    kind: 'person',
                    relationship: 'review',
                    people: [UMA],
                    receive: { files: false, transcript: false, createTaskCard: false }
                  }
                }
              ]
            }
          }
        }
      }
    )
    const loaded = personOf((await host.call(UP_NEXT_RPC.list, { conversationId })).view)
    expect(loaded).toMatchObject({
      relationship: 'review',
      receive: { files: false, transcript: false }
    })

    await commit(host)

    expect(ruleOf(host)).toMatchObject({ disposition: 'feedback', includeSummary: true })
    expect(ruleOf(host).transcriptSource).toBeDefined()
  })
})

describe('the note', () => {
  it('stays empty when none was typed, so capture writes the description', async () => {
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'person', relationship: 'handoff', people: [UMA] })
    await commit(host)

    // A note equal to the title, unmarked, is how a rule says "nothing authored" (`session-handoff-capture.ts`).
    expect(ruleOf(host).note).toBe(ruleOf(host).taskTitle)
    expect(ruleOf(host).noteAuthored).toBeUndefined()
  })

  it("reaches the people even when it is the first stage's own words", async () => {
    const host = harness()
    await append(host, stage('Sign the receipts.'))
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [UMA],
      receive: { note: 'Sign the receipts.' }
    })
    await commit(host)

    const rule = ruleOf(host)
    expect(rule.note).toBe('Sign the receipts.')
    // The mark, not a dodged title, is what keeps a note equal to the stage's words theirs.
    expect(rule.noteAuthored).toBe(true)
  })
})

describe('a send that does not wait, with blocks after it', () => {
  it('commits the send alone and leaves what follows as drafts that never run', async () => {
    const host = harness()
    const id = personOf((await append(host, { kind: 'person', people: [UMA] })).view).id
    const composed = (await append(host, stage('Only if they agree.'))).view
    expect(upNextWontRun(composed.blocks, 1)).toBe(false)

    // The person unticks it: allowed, and the step after it is marked at once.
    const unticked = (
      await host.call(UP_NEXT_RPC.update, {
        conversationId,
        blockId: id,
        patch: { kind: 'person', relationship: 'handoff' }
      })
    ).view
    expect(upNextWontRun(unticked.blocks, 1)).toBe(true)
    expect(unticked.canAdd.agent).toBe(false)

    const { view } = await commit(host)

    // Only the send was queued, as a hand off; the stage was never compiled.
    expect(host.chains()[0]!.steps.map((step) => step.kind ?? 'agent')).toEqual(['handoff'])
    expect(ruleOf(host).disposition).toBe('ownership-transfer')
    // It stays the person's draft — not held, not queued — below where the track ends.
    expect(host.drafts()?.entries.map((entry) => [entry.input.kind, entry.held])).toEqual([
      ['agent', undefined]
    ])
    const index = view.blocks.findIndex((block) => block.kind === 'agent')
    expect(view.blocks[index]!.state).toBe('draft')
    expect(upNextWontRun(view.blocks, index)).toBe(true)
    // Queueing again never commits it from there.
    await expect(commit(host)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.noDrafts)
    expect(host.commits).toHaveLength(1)
  })

  it('refuses to stop waiting while queued work after it would still run', async () => {
    const host = harness()
    await append(host, stage('First.'))
    await append(host, stage('Second.'))
    await commit(host)
    const first = (await list(host)).blocks[0]!
    // An older draft put above queued work before that was refused, as it was stored.
    replaceDrafts(host, [
      {
        id: 'draft:old-send',
        createdAt: 5,
        afterBlockId: first.id,
        input: { kind: 'person', people: [UMA] }
      }
    ])
    const composed = await list(host)
    expect(composed.blocks.map((block) => block.kind)).toEqual(['agent', 'person', 'agent'])
    // Nothing it can hold follows it, so it promises no pause: the stage after it runs first.
    expect(upNextStepsAfter(composed.blocks, 1)).toBe(0)

    await expect(
      host.call(UP_NEXT_RPC.update, {
        conversationId,
        blockId: personOf(composed).id,
        patch: { kind: 'person', relationship: 'handoff' }
      })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  })
})

describe('a send is never placed above work already queued', () => {
  async function queuedTwice(host: UpNextHarness): Promise<UpNextView> {
    await append(host, stage('First.'))
    await append(host, stage('Second.'))
    await commit(host)
    return list(host)
  }

  it('refuses to insert one ahead of queued work, and adds nothing', async () => {
    const host = harness()
    const queued = await queuedTwice(host)
    await expect(
      append(host, { kind: 'person', people: [UMA] }, { insertAfterBlockId: queued.blocks[0]!.id })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.sendAfterQueued)
    expect((await list(host)).blocks.map((block) => block.kind)).toEqual(['agent', 'agent'])
    // After the last queued block is exactly where the people are asked.
    const placed = await append(
      host,
      { kind: 'person', people: [UMA] },
      { insertAfterBlockId: queued.blocks[1]!.id }
    )
    expect(placed.view.blocks.map((block) => block.kind)).toEqual(['agent', 'agent', 'person'])
  })

  it('refuses to move one up past queued work, and still moves it past composed work', async () => {
    const host = harness()
    await queuedTwice(host)
    await append(host, stage('Composed.'))
    const view = (await append(host, { kind: 'person', people: [UMA] })).view
    const send = personOf(view).id
    const move = (direction: -1 | 1) =>
      host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: send, direction })

    expect((await move(-1)).view.blocks.map((block) => block.state)).toEqual([
      'queued',
      'queued',
      'draft',
      'draft'
    ])
    expect(personOf(await list(host)).id).toBe((await list(host)).blocks[2]!.id)
    await expect(move(-1)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.sendAfterQueued)
    expect((await list(host)).blocks[2]!.id).toBe(send)
  })
})

describe('a send that did not go out', () => {
  /** What the host's delivery wrote back onto the committed send. */
  function deliveryWrote(host: UpNextHarness, patch: Partial<SessionChainHandoffStep['handoff']>) {
    const run = host.chains()[0]!
    host.service.save({
      ...run,
      steps: run.steps.map((step) =>
        step.kind === 'handoff' ? { ...step, handoff: { ...step.handoff, ...patch } } : step
      )
    })
  }

  it('keeps its own state, so one that failed before capture can still be removed', async () => {
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'person', relationship: 'handoff', people: [UMA] })
    await commit(host)
    // Capture refused the conversation: a stop no resend can fix.
    deliveryWrote(host, {
      exception: { code: 'unreadable', subject: 'conversation', detail: 'Refused.', at: Date.now() }
    })

    const failed = personOf(await list(host))
    expect(failed).toMatchObject({ state: 'queued', locked: false, sendFailure: 'failed' })
    expect(failed.reachedIds).toBeUndefined()

    await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: failed.id })
    const after = await list(host)
    expect(after.blocks.some((block) => block.kind === 'person')).toBe(false)
    expect(after.canAdd.agent).toBe(true)
  })

  it('names who it already reached when the hub refused somebody else', async () => {
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'person', relationship: 'review', people: [UMA, GAMMA] })
    await commit(host)
    const recipients = ruleOf(host).recipients.map((recipient) =>
      recipient.employeeId === UMA.id
        ? { ...recipient, delivery: 'sent' as const, at: 50, threadId: 'hth_uma' }
        : { ...recipient, delivery: 'failed' as const, error: 'Refused.', at: Date.now() }
    )
    deliveryWrote(host, { recipients })

    // The host resends a refusal by itself first; either way Uma already has it.
    expect(personOf(await list(host))).toMatchObject({
      state: 'running',
      sendFailure: 'recovering',
      reachedIds: [UMA.id]
    })
  })
})

describe('a host that cannot read the conversation', () => {
  it('says so while a send is composed, and sends the files and summary without it', async () => {
    const host = harness({}, { transcriptSource: null })
    expect((await append(host, stage())).view.sendsConversation).toBeUndefined()
    const composed = (
      await append(host, { kind: 'person', relationship: 'handoff', people: [UMA] })
    ).view
    expect(composed.sendsConversation).toBe(false)

    await commit(host)
    expect(ruleOf(host)).toMatchObject({ disposition: 'ownership-transfer', includeSummary: true })
    expect(ruleOf(host).transcriptSource).toBeUndefined()
  })

  it('promises the conversation where the host can read it', async () => {
    const host = harness()
    const composed = (await append(host, { kind: 'person', people: [UMA] })).view
    expect(composed.sendsConversation).toBe(true)
  })
})
