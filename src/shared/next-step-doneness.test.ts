import { describe, expect, it } from 'vitest'
import {
  nextStepDonePercent,
  nextStepLooksDone,
  nextStepPushIsSpent,
  type NextStepDoneness
} from './next-step-doneness'

const reading = (patch: Partial<NextStepDoneness>): NextStepDoneness => ({
  resolved: 0.95,
  remainingWork: 0.1,
  roomToImprove: 0.1,
  verified: 0.9,
  unsure: false,
  turnKey: 't',
  at: 1,
  ...patch
})

describe('nextStepLooksDone', () => {
  it('is done only when resolved, no required work missing, and checked', () => {
    expect(nextStepLooksDone(reading({}))).toBe(true)
    expect(nextStepLooksDone(reading({ resolved: 0.85 }))).toBe(false)
    expect(nextStepLooksDone(reading({ remainingWork: 0.3 }))).toBe(false)
    expect(nextStepLooksDone(reading({ verified: 0.5 }))).toBe(false)
  })

  it('ignores room to improve: finished work can still be improved', () => {
    expect(nextStepLooksDone(reading({ roomToImprove: 0.6, unsure: true }))).toBe(true)
  })

  it('checks each deciding reading on its own, never a missing one', () => {
    // 0.2 and 0.8 sit on the band's edges, outside it.
    expect(nextStepLooksDone(reading({ remainingWork: 0.2, verified: 0.8 }))).toBe(true)
    expect(nextStepLooksDone(reading({ remainingWork: 0.21 }))).toBe(false)
    expect(nextStepLooksDone(reading({ verified: 0.79 }))).toBe(false)
    expect(nextStepLooksDone(null)).toBe(false)
    expect(nextStepLooksDone(undefined)).toBe(false)
  })
})

describe('nextStepPushIsSpent', () => {
  it('stops pushing when there is clearly no room left or the last round clearly did not help', () => {
    expect(nextStepPushIsSpent(reading({ roomToImprove: 0.1 }), null)).toBe(true)
    expect(nextStepPushIsSpent(null, { improved: 0.1, unsure: false })).toBe(true)
  })

  it('keeps pushing on unsure or missing readings', () => {
    expect(nextStepPushIsSpent(reading({ roomToImprove: 0.25 }), null)).toBe(false)
    // Another reading's doubt does not void a clear room reading.
    expect(
      nextStepPushIsSpent(reading({ roomToImprove: 0.1, resolved: 0.5, unsure: true }), null)
    ).toBe(true)
    expect(nextStepPushIsSpent(null, { improved: 0.1, unsure: true })).toBe(false)
    expect(
      nextStepPushIsSpent(reading({ roomToImprove: 0.6 }), { improved: 0.7, unsure: false })
    ).toBe(false)
    expect(nextStepPushIsSpent(null, null)).toBe(false)
  })
})

it('shows a percentage only for a clear resolved reading', () => {
  expect(nextStepDonePercent(reading({ resolved: 0.853 }))).toBe(85)
  expect(nextStepDonePercent(reading({ resolved: 0.5 }))).toBeNull()
  expect(nextStepDonePercent(null)).toBeNull()
})
