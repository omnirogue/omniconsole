import { describe, expect, it } from 'vitest'
import {
  BROWSER_LOGIN_POLL_TIMEOUT_MS,
  nextBrowserLoginPollOutcome
} from './browser-logins-polling'

describe('the browser-login re-login poll outcome', () => {
  it('keeps polling while the status is neither verified nor an error and time remains', () => {
    expect(nextBrowserLoginPollOutcome('not_checked', 0)).toBe('continue')
    expect(nextBrowserLoginPollOutcome('sign_in_required', 30_000)).toBe('continue')
  })

  it('stops as soon as the hub reports the session verified', () => {
    expect(nextBrowserLoginPollOutcome('verified', 0)).toBe('verified')
  })

  it('stops as soon as the hub reports an error, even early', () => {
    expect(nextBrowserLoginPollOutcome('error', 3000)).toBe('error')
  })

  it('times out after the 3-minute budget with neither a verified nor an error status', () => {
    expect(nextBrowserLoginPollOutcome('not_checked', BROWSER_LOGIN_POLL_TIMEOUT_MS - 1)).toBe(
      'continue'
    )
    expect(nextBrowserLoginPollOutcome('not_checked', BROWSER_LOGIN_POLL_TIMEOUT_MS)).toBe(
      'timed_out'
    )
  })

  it('prefers a verified status over an expired budget', () => {
    expect(nextBrowserLoginPollOutcome('verified', BROWSER_LOGIN_POLL_TIMEOUT_MS + 1)).toBe(
      'verified'
    )
  })
})
