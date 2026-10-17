/**
 * The plain words for a run that stopped. The host's diagnostic is never one of them: a failure
 * is named by its CODE, and a code this build does not know still gets an honest sentence.
 */
import { expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

import {
  failureLabel,
  stoppedHeaderLine,
  stoppedStageLine,
  untilLabel,
  wakeLabel
} from './up-next-run-labels'

const NOW = 1_700_000_000_000

it('names a failure by its code, and an unknown code honestly', () => {
  expect(failureLabel('worker-stalled')).toBe('The agent stopped responding')
  expect(failureLabel('startup-blocked')).toBe('The agent could not get past its startup')
  expect(failureLabel('unclassified')).toBe('Automatic recovery could not continue')
  expect(failureLabel(undefined)).toBe('Automatic recovery could not continue')
})

it('counts down to the next automatic attempt', () => {
  expect(untilLabel(NOW + 45_000, NOW)).toBe('in 45s')
  expect(untilLabel(NOW + 5 * 60_000, NOW)).toBe('in 5 min')
  expect(untilLabel(NOW - 1, NOW)).toBe('now')
})

it('says the policy’s generic wakes in the UI’s words and a person’s name as it is', () => {
  expect(wakeLabel('evidence')).toBe('verified evidence')
  expect(wakeLabel(undefined)).toBe('verified evidence')
  expect(wakeLabel('execution host')).toBe('the execution host')
  expect(wakeLabel('Jordan Taylor')).toBe('Jordan Taylor')
})

it('writes one header line per class of stop, none of them "needs you"', () => {
  const lines = [
    stoppedHeaderLine({ state: 'recovering' }, NOW),
    stoppedHeaderLine({ state: 'recovering', recoveringUntil: NOW + 15_000 }, NOW),
    stoppedHeaderLine({ state: 'waiting', wake: 'Jordan Taylor' }, NOW),
    stoppedHeaderLine({ state: 'failed', failure: { code: 'worker-stalled' } }, NOW)
  ]
  expect(lines).toEqual([
    'Recovering automatically',
    'Recovering automatically · next attempt in 15s',
    'Waiting for Jordan Taylor',
    'Failed · The agent stopped responding'
  ])
  for (const line of [...lines, stoppedStageLine('recovering', undefined)]) {
    expect(line).not.toMatch(/needs you/i)
  }
  // The diagnostic is not an input: a failure line is the same whatever the host's prose said.
  expect(
    stoppedHeaderLine(
      { state: 'failed', failure: { code: 'worker-stalled', reason: 'No activity was observed' } },
      NOW
    )
  ).toBe('Failed · The agent stopped responding')
  expect(stoppedStageLine('failed', 'worker-stalled')).toBe('The agent stopped responding')
})

it('names what stopped the work held behind a person review, never the host’s diagnostic', () => {
  expect(failureLabel('continuation-held')).toBe('The work queued after the review was not started')
  expect(failureLabel('continuation-refused')).toBe(
    'The work queued after the review could not be started'
  )
  expect(failureLabel('review-fix-failed')).toBe(
    'The reviewer’s notes could not be given to the agent'
  )
})
