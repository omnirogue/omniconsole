/**
 * The words "Send to a person" says. Under the checkbox, the sentence that changes with the
 * tick — ticked or not, with no, one or several steps after it, to one, two or three people.
 * Under a sent block, one line per state, read only from host facts: its committed and delivery
 * state and what its review has heard back (`UpNextReviewWaiting`).
 */
import { describe, expect, it } from 'vitest'
import type {
  UpNextBlock,
  UpNextPersonBlock,
  UpNextReviewWaiting,
  UpNextView
} from '../../../../shared/up-next-types'
import { agentFixture, upNextFixture } from './up-next-fixture'
import { clockLabel, primaryLabel } from './up-next-labels'
import { sendConsequence, sendStatus } from './up-next-person-lines'

const UMA = { id: 'emp_uma', name: 'Uma', initials: 'UM' }
const GAMMA = { id: 'emp_gamma', name: 'Gamma', initials: 'GA' }
const IRIS = { id: 'emp_iris', name: 'Iris', initials: 'IR' }
const CROWDS = [[UMA], [UMA, GAMMA], [UMA, GAMMA, IRIS]]

describe('the sentence under "Wait for their OK"', () => {
  const until = ['until Uma says OK', 'until Uma and Gamma both say OK', 'until all 3 say OK']
  const theirs = [
    "It becomes Uma's.",
    "It becomes Uma and Gamma's.",
    "It becomes Uma, Gamma and Iris's."
  ]

  it.each([0, 1, 2])('reads the consequence of the tick for %i+1 people', (crowd) => {
    const people = CROWDS[crowd]!
    expect(sendConsequence(people, true, 0)).toBe(
      "Nothing else runs after this; you'll see their answer here."
    )
    expect(sendConsequence(people, true, 1)).toBe(`Your next step will PAUSE ${until[crowd]}.`)
    expect(sendConsequence(people, true, 3)).toBe(`Your 3 next steps will PAUSE ${until[crowd]}.`)
    expect(sendConsequence(people, false, 0)).toBe(theirs[crowd])
    expect(sendConsequence(people, false, 1)).toBe(`${theirs[crowd]} Your next step won't run.`)
    expect(sendConsequence(people, false, 3)).toBe(`${theirs[crowd]} Your next steps won't run.`)
  })

  it('still says what happens before anyone is chosen', () => {
    expect(sendConsequence([], true, 3)).toBe('Your 3 next steps will PAUSE until they say OK.')
    expect(sendConsequence([], false, 0)).toBe('It becomes theirs.')
  })
})

function sent(patch: Partial<UpNextPersonBlock> = {}): UpNextPersonBlock {
  return {
    id: 'step:ask',
    kind: 'person',
    state: 'waiting',
    number: '1',
    locked: true,
    relationship: 'review',
    people: [UMA],
    receive: { files: true, transcript: true, createTaskCard: false },
    ...patch
  }
}

/** `held` blocks the host is holding behind the send, as the view carries them. */
function viewOf(block: UpNextPersonBlock, held = 0, rest: UpNextBlock[] = []): UpNextView {
  const behind = Array.from({ length: held }, (_, index) =>
    agentFixture(`draft:${index}`, {
      state: 'waiting',
      heldFor: { kind: 'review', blockId: block.id }
    })
  )
  return { ...upNextFixture('busy'), blocks: [block, ...behind, ...rest] }
}

const waiting = (over: Partial<UpNextReviewWaiting> = {}): UpNextReviewWaiting => ({
  replied: 0,
  total: 1,
  sinceMs: 60_000,
  approved: 0,
  round: 1,
  fixing: false,
  answers: [],
  changes: [],
  ...over
})

const line = (block: UpNextPersonBlock, held = 0, rest: UpNextBlock[] = []) =>
  sendStatus(block, viewOf(block, held, rest))

describe('the status line under a sent block', () => {
  it('says nothing while the block is still composed', () => {
    expect(line(sent({ id: 'draft:p', state: 'draft', locked: false }))).toBeNull()
  })

  it('says a send that did not go out changed nothing', () => {
    for (const sendFailure of ['failed', 'recovering'] as const) {
      // The failure rides beside the block's own state, which is what keeps it removable.
      expect(line(sent({ state: 'queued', locked: false, sendFailure }))).toEqual({
        kind: 'failed',
        text: "Didn't send. Nothing changed."
      })
    }
  })

  it('names who a send reached and who it missed, when it reached anybody', () => {
    const partly = { state: 'running' as const, sendFailure: 'recovering' as const }
    expect(line(sent({ ...partly, people: [UMA, GAMMA], reachedIds: ['emp_uma'] }))).toEqual({
      kind: 'part-sent',
      text: "Sent to Uma. Didn't reach Gamma."
    })
    expect(
      line(sent({ ...partly, people: [UMA, GAMMA, IRIS], reachedIds: ['emp_gamma'] }))?.text
    ).toBe("Sent to Gamma. Didn't reach Uma and Iris.")
    // A receipt for somebody no longer named reaches nobody on this block.
    expect(line(sent({ ...partly, reachedIds: ['emp_gone'] }))?.kind).toBe('failed')
    // Everyone named got it and an agent recipient after them failed: no blank name.
    expect(
      line(sent({ ...partly, people: [UMA, GAMMA], reachedIds: ['emp_uma', 'emp_gamma'] }))
    ).toEqual({ kind: 'part-sent', text: "Sent to Uma and Gamma. The rest didn't go out." })
  })

  it('says a send not out yet, and one on its way', () => {
    expect(line(sent({ state: 'queued', locked: false }))?.text).toBe(
      'Sends when the work before it is done.'
    )
    expect(line(sent({ state: 'running' }))?.text).toBe('Sending…')
  })

  it('names who got a hand off and when, and that nothing waits', () => {
    const at = Date.UTC(2026, 8, 18, 14, 14)
    const handoff = { state: 'done' as const, relationship: 'handoff' as const, people: [GAMMA] }
    expect(line(sent({ ...handoff, sentAt: at }))?.text).toBe(
      `Sent to Gamma ${clockLabel(at)}. Nothing is waiting.`
    )
    expect(line(sent(handoff))?.text).toBe('Sent to Gamma. Nothing is waiting.')
  })

  it("waits for everyone's OK and counts the steps it paused", () => {
    expect(line(sent({ waiting: waiting() }), 3)?.text).toBe(
      "Waiting for Uma's OK. 3 steps paused."
    )
    expect(line(sent({ waiting: waiting() }), 1)?.text).toBe("Waiting for Uma's OK. 1 step paused.")
    expect(line(sent({ waiting: waiting() }))?.text).toBe("Waiting for Uma's OK.")
    expect(line(sent({ people: [UMA, GAMMA], waiting: waiting({ total: 2 }) }), 3)?.text).toBe(
      'Waiting for Uma and Gamma to say OK. 3 steps paused.'
    )
    expect(
      line(sent({ people: [UMA, GAMMA, IRIS], waiting: waiting({ total: 3 }) }), 2)?.text
    ).toBe('Waiting for all 3 to say OK. 2 steps paused.')
  })

  it('counts who said OK so far', () => {
    const one = waiting({
      replied: 1,
      total: 2,
      approved: 1,
      answers: [{ employeeId: 'emp_uma', name: 'Uma', decision: 'approve' }]
    })
    expect(line(sent({ people: [UMA, GAMMA], waiting: one }), 3)).toEqual({
      kind: 'partial',
      text: '1 of 2 said OK.'
    })
  })

  it('says the steps run once everyone said OK', () => {
    const approved = sent({ state: 'done' })
    expect(line(approved, 0, [agentFixture('node:fix', { state: 'running' })])?.text).toBe(
      'Uma said OK. Your steps are running now.'
    )
    expect(line(approved, 0, [agentFixture('node:fix', { state: 'queued' })])?.text).toBe(
      'Uma said OK. Your steps are running now.'
    )
    expect(line(approved)?.text).toBe('Uma said OK.')
  })

  it('never says the steps run when nothing after it was released', () => {
    const approved = sent({ state: 'done' })
    // A draft added after it never ran, and a release the host refused leaves its work held.
    const draft = agentFixture('draft:later', { state: 'draft' })
    const refused = agentFixture('draft:held', {
      state: 'waiting',
      heldFor: { kind: 'review', blockId: approved.id }
    })
    expect(line(approved, 0, [draft])?.text).toBe('Uma said OK.')
    expect(line(approved, 0, [refused, draft])?.text).toBe('Uma said OK.')
    // Work queued BEFORE the review is not what it released.
    const before = { ...upNextFixture('busy'), blocks: [agentFixture('node:earlier'), approved] }
    expect(sendStatus(approved, before)?.text).toBe('Uma said OK.')
  })

  it('quotes the changes asked for while the steps stay paused', () => {
    const asked = waiting({
      replied: 1,
      answers: [{ employeeId: 'emp_uma', name: 'Uma', decision: 'request_changes' }],
      changes: [{ employeeId: 'emp_uma', name: 'Uma', round: 1, note: 'Tighten the intro' }]
    })
    expect(line(sent({ waiting: asked }), 3)).toEqual({
      kind: 'changes',
      text: "Uma wants changes: 'Tighten the intro'. Steps still paused."
    })
    const bare = { ...asked, changes: [] }
    expect(line(sent({ waiting: bare }), 3)?.text).toBe('Uma wants changes. Steps still paused.')
    const long = 'x'.repeat(200)
    const cut = line(
      sent({ waiting: { ...asked, changes: [{ ...asked.changes![0]!, note: long }] } })
    )
    expect(cut?.text).toBe(`Uma wants changes: '${'x'.repeat(120)}…'.`)
    expect(cut?.title).toBe(long)
  })

  it('says the agent is making the changes, then that the reviewer was asked again', () => {
    expect(line(sent({ waiting: waiting({ fixing: true }) }), 3)?.text).toBe(
      'Your agent is making the changes.'
    )
    expect(line(sent({ waiting: waiting({ round: 2 }) }), 3)?.text).toBe(
      'Asked Uma again (round 2).'
    )
  })
})

describe('the primary button', () => {
  it('reads Send for a lone send and never counts what will not run', () => {
    const send = sent({ id: 'draft:p', state: 'draft', locked: false, relationship: 'handoff' })
    const view = viewOf(send, 0, [agentFixture('draft:after', { state: 'draft' })])
    expect(primaryLabel(view)).toBe('Send')
  })
})
