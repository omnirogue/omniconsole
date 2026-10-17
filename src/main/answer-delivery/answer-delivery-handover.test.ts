import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAIMER_FRESH_MS,
  beginCardTyping,
  cardTouched,
  cardTyped,
  cardTypingOutcome,
  cardTypingUncertain,
  claimerTakes,
  clearClaimerPolled,
  endCardTyping,
  leftToClaimer,
  noteClaimerPolled,
  resetAnswerHandoverForTests
} from './answer-delivery-handover'

beforeEach(() => resetAnswerHandoverForTests())

describe('claimerTakes', () => {
  it('is true only for the kinds it polled, while the poll is fresh', () => {
    noteClaimerPolled(['review', 'question'], 1_000)
    expect(claimerTakes('review', 1_000 + CLAIMER_FRESH_MS - 1)).toBe(true)
    expect(claimerTakes('jira', 1_000)).toBe(false)
    expect(claimerTakes('review', 1_000 + CLAIMER_FRESH_MS)).toBe(false)
    clearClaimerPolled()
    expect(claimerTakes('review', 1_000)).toBe(false)
  })
})

describe('leftToClaimer', () => {
  it('never takes an answer without a delivery key', () => {
    noteClaimerPolled(['review'], 0)
    expect(leftToClaimer('review', null, { state: 'typed' }, 0)).toBe(false)
    expect(leftToClaimer('review', '', undefined, 0)).toBe(false)
  })

  it('takes every keyed answer while the claimer polls', () => {
    noteClaimerPolled(['review'], 0)
    expect(leftToClaimer('review', 'review:p:d1', undefined, 0)).toBe(true)
    expect(leftToClaimer('review', 'review:p:d1', { state: 'pending' }, 0)).toBe(true)
  })

  it('without a polling claimer, takes only what was already started for it', () => {
    const left = (delivery: { state?: string; step?: string } | null | undefined) =>
      leftToClaimer('review', 'review:p:d1', delivery, 0)
    expect(left(undefined)).toBe(false)
    expect(left(null)).toBe(false)
    expect(left({ state: 'pending' })).toBe(false)
    expect(left({ state: 'held', step: 'claimed' })).toBe(false)
    expect(left({ state: 'held', step: 'resumed' })).toBe(true)
    expect(left({ state: 'claimed' })).toBe(true)
    expect(left({ state: 'typed' })).toBe(true)
    expect(left({ state: 'done' })).toBe(true)
  })
})

describe('card typing marks', () => {
  it('lets only one path type an answer at a time, and remembers what landed', () => {
    expect(beginCardTyping('question:1:a1')).toBe(true)
    expect(beginCardTyping('question:1:a1')).toBe(false)
    expect(cardTouched('question:1:a1')).toBe(true)
    endCardTyping('question:1:a1', 'typed')
    expect(cardTyped('question:1:a1')).toBe(true)
    expect(cardTouched('question:1:a2')).toBe(false)
  })

  it('remembers an unconfirmed attempt, and forgets a clean refusal', () => {
    beginCardTyping('question:1:a1')
    endCardTyping('question:1:a1', 'uncertain')
    expect(cardTypingUncertain('question:1:a1')).toBe(true)
    beginCardTyping('question:2:a1')
    endCardTyping('question:2:a1', 'refused')
    expect(cardTouched('question:2:a1')).toBe(false)
  })
})

describe('cardTypingOutcome', () => {
  it('counts only refusals that say nothing went in as clean', () => {
    expect(cardTypingOutcome({ delivered: true })).toBe('typed')
    for (const error of [
      'The session is no longer waiting on this question; nothing was typed.',
      'The terminal did not take the answer; nothing was sent. Answer it at the desktop.',
      'This OmniConsole window cannot type OmniOS answers yet; reload it and retry.'
    ]) {
      expect(cardTypingOutcome({ delivered: false, error })).toBe('refused')
    }
    for (const error of [
      'The desktop window did not confirm the answer; check the session before answering again.',
      'The answer was partly typed; finish it in the terminal before answering again.',
      'The desktop could not apply this answer.'
    ]) {
      expect(cardTypingOutcome({ delivered: false, error })).toBe('uncertain')
    }
  })
})
