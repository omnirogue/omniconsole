/**
 * The one choice on "Send to a person", read the same way on both sides: a block nobody has
 * ticked waits exactly when something still to run follows it; a choice the person made is
 * never changed by what is added after it; and a send that does not wait ends the track, so
 * what was composed behind it never runs from there.
 */
import { describe, expect, it } from 'vitest'
import { upNextChangeRefusal, upNextTargetOf } from './up-next-order'
import {
  upNextSendAboveQueued,
  upNextSendEnd,
  upNextSendWaits,
  upNextStepsAfter,
  upNextStepsPausedBy,
  upNextWithSendChoices,
  upNextWontRun,
  type UpNextSendBlock
} from './up-next-person-send'
import { UP_NEXT_REFUSAL_KEYS, type UpNextBlock, type UpNextPersonBlock } from './up-next-types'

const person = (
  relationship: UpNextSendBlock['relationship'],
  state: UpNextSendBlock['state'] = 'draft'
): UpNextSendBlock => ({ kind: 'person', state, relationship })
const agent = (state: UpNextSendBlock['state'] = 'draft'): UpNextSendBlock => ({
  kind: 'agent',
  state
})

describe('the default of a send nobody has ticked', () => {
  it('waits when a step it can hold follows it, and not when it is last', () => {
    expect(upNextSendWaits([person(null)], 0)).toBe(false)
    expect(upNextSendWaits([person(null), agent()], 0)).toBe(true)
    expect(upNextSendWaits([person(null), { kind: 'done', state: 'draft' }], 0)).toBe(true)
    // Finished work below it is history, not a next step.
    expect(upNextSendWaits([person(null), agent('done')], 0)).toBe(false)
    // Queued work runs whatever the send says: the people are the plan's own finish.
    expect(upNextSendWaits([person(null), agent('queued')], 0)).toBe(false)
  })

  it('keeps what the person chose whatever follows', () => {
    expect(upNextSendWaits([person('handoff'), agent(), agent()], 0)).toBe(false)
    expect(upNextSendWaits([person('review')], 0)).toBe(true)
  })

  it('counts only the steps its commit can hold', () => {
    expect(upNextStepsAfter([person(null)], 0)).toBe(0)
    // [A1 running, send, A2 queued] promised "Your next step will PAUSE" while A2 ran first.
    expect(
      upNextStepsAfter([agent('running'), person(null), agent('queued'), agent('running')], 1)
    ).toBe(0)
    expect(upNextStepsAfter([person(null), agent(), agent('queued'), agent('done')], 0)).toBe(1)
    // Work already held behind a review is still composed: on its release this send holds it.
    const held = { ...agent('waiting'), heldFor: { blockId: 'step:earlier' } }
    expect(upNextStepsAfter([person(null), held, agent()], 0)).toBe(2)
    expect(upNextSendWaits([person(null), held], 0)).toBe(true)
  })

  it('pauses only up to a later send that ends the track', () => {
    // [Send 1, D1, Send 2 unticked, D2]: the commit holds D1 and Send 2; D2 stays a draft.
    const blocks = [person(null), agent(), person('handoff'), agent()]
    expect(upNextStepsPausedBy(blocks, 0)).toBe(2)
    expect(upNextStepsAfter(blocks, 0)).toBe(3)
    // A later send that waits too pauses what is behind it as well.
    expect(upNextStepsPausedBy([person('review'), agent(), person('review'), agent()], 0)).toBe(3)
    expect(upNextStepsPausedBy([person('review')], 0)).toBe(0)
  })
})

describe('where a composed send may sit', () => {
  const send = { id: 'draft:send', kind: 'person' as const }

  it('never above work already queued, which would run before the people are asked', () => {
    expect(upNextSendAboveQueued(send, [{ id: 'node:a2' }])).toBe(true)
    expect(upNextSendAboveQueued(send, [{ id: 'draft:a' }, { id: 'sp:step_1:p1' }])).toBe(true)
  })

  it('above composed and held work, and nowhere else is it asked', () => {
    expect(upNextSendAboveQueued(send, [{ id: 'draft:a' }, { id: 'draft:held' }])).toBe(false)
    expect(upNextSendAboveQueued(send, [])).toBe(false)
    // A send already committed, or any other kind of draft, is not this rule's business.
    expect(upNextSendAboveQueued({ id: 'step:ask', kind: 'person' }, [{ id: 'node:a' }])).toBe(
      false
    )
    expect(upNextSendAboveQueued({ id: 'draft:a', kind: 'agent' }, [{ id: 'node:a' }])).toBe(false)
  })
})

describe('a send that does not wait', () => {
  it('ends the track, and only the composed blocks after it are marked', () => {
    const blocks = [agent('queued'), person('handoff'), agent(), { kind: 'prompt', state: 'draft' }]
    expect(upNextSendEnd(blocks as UpNextSendBlock[])).toBe(1)
    expect([0, 1, 2, 3].map((index) => upNextWontRun(blocks as UpNextSendBlock[], index))).toEqual([
      false,
      false,
      true,
      true
    ])
  })

  it('is no end at all while it waits', () => {
    const blocks = [person('review'), agent()]
    expect(upNextSendEnd(blocks)).toBe(-1)
    expect(upNextWontRun(blocks, 1)).toBe(false)
    // Untouched and last: it is the end, and nothing is behind it.
    expect(upNextSendEnd([agent(), person(null)])).toBe(1)
  })
})

describe('what the host commits', () => {
  const base = {
    number: '',
    locked: false,
    people: [{ id: 'emp_1', name: 'Uma', initials: 'UM' }],
    receive: { files: true, transcript: true, createTaskCard: false }
  }
  const draft = (id: string): UpNextPersonBlock => ({
    ...base,
    id,
    kind: 'person',
    state: 'draft',
    relationship: null
  })

  it('writes every untouched default out and leaves chosen ones alone', () => {
    const stage: UpNextBlock = {
      id: 'draft:stage',
      kind: 'agent',
      state: 'draft',
      number: '',
      locked: false,
      template: 'improve',
      shape: 'solo',
      n: 1,
      instruction: '',
      output: 'result',
      intent: 'handoff',
      advanced: {},
      promptCount: 0
    }
    const chosen: UpNextPersonBlock = { ...draft('draft:c'), relationship: 'handoff' }
    const resolved = upNextWithSendChoices([draft('draft:a'), stage, draft('draft:b'), chosen])
    expect(
      resolved.map((block) => (block.kind === 'person' ? block.relationship : block.kind))
    ).toEqual(['review', 'agent', 'review', 'handoff'])
  })

  it('sends a prompt below an untouched send to the agent that resumes after it', () => {
    const blocks = [
      { id: 'p', kind: 'person' as const, relationship: null },
      { id: 'q', kind: 'prompt' as const }
    ]
    expect(upNextTargetOf(blocks, 1)).toEqual({ kind: 'resume-after-review', blockId: 'p' })
  })
})

describe('unticking a send that has blocks after it', () => {
  const untick = { kind: 'person' as const, relationship: 'handoff' as const }

  it('is allowed while everything after it is still composed', () => {
    const blocks = [
      { id: 'draft:p', kind: 'person' as const, state: 'draft' as const },
      { id: 'draft:a', kind: 'agent' as const, state: 'draft' as const }
    ]
    expect(upNextChangeRefusal(blocks, 'draft:p', untick)).toBeUndefined()
  })

  it('is refused while queued or held work after it would still run', () => {
    for (const state of ['queued', 'waiting'] as const) {
      const blocks = [
        { id: 'draft:p', kind: 'person' as const, state: 'draft' as const },
        { id: 'node:a', kind: 'agent' as const, state }
      ]
      expect(upNextChangeRefusal(blocks, 'draft:p', untick)).toBe(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    }
  })
})
