import { describe, expect, it } from 'vitest'
import {
  conversationFence,
  conversationGuard,
  freeformApprovalRefusal,
  freeformRefusal,
  UNREAD_TURN,
  type SessionLatestTurn
} from './session-manage-freeform'

const turn = (text: string | null, over: Partial<SessionLatestTurn> = {}): SessionLatestTurn => ({
  known: true,
  turnKey: 't1',
  text,
  complete: text !== null,
  proposal: null,
  empty: false,
  ...over
})
const idle = (latest: SessionLatestTurn) => freeformRefusal({ state: 'idle', turn: latest })

describe('freeformRefusal', () => {
  it('admits only a whole, finished reply with nothing open, on an idle target', () => {
    expect(idle(turn('The parser handles nested quotes now.'))).toBeNull()
    expect(
      freeformRefusal({ state: 'working', turn: turn('The parser handles nested quotes now.') })
    ).toContain('not idle')
  })

  it('refuses an unread, unknown, partial or missing reply', () => {
    for (const latest of [
      UNREAD_TURN,
      turn('Done.', { known: false }),
      turn('Done.', { turnKey: null }),
      turn('Done.', { complete: false }),
      turn(null)
    ]) {
      expect(idle(latest)).toContain('could not be read in full')
    }
  })

  it('refuses any proposal of its own, a hard stop anywhere, or a closing question', () => {
    expect(idle(turn('Done.', { proposal: '["s1"]' }))).toContain('proposes next steps')
    const buried = `Pushing to main is next.\n\n${'Notes on the parser change. '.repeat(60)}`
    expect(idle(turn(buried))).toContain('hard stop: shared-branch')
    expect(idle(turn('Tests pass.\n\nWant me to keep going with the docs?'))).toContain(
      'ends on a question'
    )
    const raise = turn('The CPA halved overnight. Next: raise the SD25 daily budget to $300.')
    expect(idle(raise)).toContain('hard stop: ad-spend')
    // An ad pause is allowed unless the target asks first.
    const pause = turn('The CPA doubled overnight. Next: pause ad set 4 in SD25.')
    expect(idle(pause)).toBeNull()
    expect(freeformRefusal({ state: 'idle', turn: pause, adPauses: 'ask-first' })).toContain(
      'hard stop: ad-pause'
    )
    // A question earlier in the reply, answered by the reply itself, is not an open one.
    expect(idle(turn('Why did it fail? A stale fixture.\n\nFixed it.'))).toBeNull()
  })
})

describe('a conversation positively known never to have replied', () => {
  const empty: SessionLatestTurn = { ...UNREAD_TURN, known: true, empty: true }

  it('admits a free prompt when the host knows it is empty, never when it is merely unread', () => {
    expect(idle(empty)).toBeNull()
    expect(freeformRefusal({ state: 'working', turn: empty })).toContain('not idle')
    expect(idle({ ...empty, known: false })).toContain('could not be read in full')
    expect(idle({ ...empty, empty: false })).toContain('could not be read in full')
  })

  it('is fenced like any other: a first reply before the write refuses', async () => {
    const guard = conversationGuard(conversationFence(empty, true), true, async () => turn('Hi.'))
    await expect(guard()).resolves.toContain('changed after this was checked')
    const still = conversationGuard(conversationFence(empty, true), true, async () => empty)
    await expect(still()).resolves.toBeNull()
  })
})

describe('freeformApprovalRefusal', () => {
  it('points an approval at --yes/--choose, and lets an instruction through', () => {
    expect(freeformApprovalRefusal('go ahead')).toContain('--yes or --choose')
    expect(freeformApprovalRefusal('Run the unit tests.')).toBeNull()
  })
})

describe('conversationGuard', () => {
  const checked = turn('Tests pass.')
  const guard = (now: SessionLatestTurn | Error, withProposal = true) =>
    conversationGuard(conversationFence(checked, withProposal), withProposal, async () => {
      if (now instanceof Error) {
        throw now
      }
      return now
    })()

  it('passes only the exact content it was checked against', async () => {
    await expect(guard(turn('Tests pass.'))).resolves.toBeNull()
    for (const now of [
      turn('Tests pass. Shall I deploy?'),
      turn('Tests pass.', { turnKey: 't2' }),
      turn('Tests pass.', { proposal: '["Deploy"]' }),
      turn('Tests pass.', { complete: false })
    ]) {
      await expect(guard(now)).resolves.toContain('changed after this was checked')
    }
  })

  it('ignores the proposal only when asked to (the --yes answer settles its own)', async () => {
    await expect(guard(turn('Tests pass.', { proposal: 'settled' }), false)).resolves.toBeNull()
  })

  it('refuses a conversation it cannot read now', async () => {
    await expect(guard(UNREAD_TURN)).resolves.toContain('could not be read')
    await expect(guard(new Error('host gone'))).resolves.toContain('could not be read')
  })
})
