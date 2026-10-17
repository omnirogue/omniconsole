import { describe, expect, it } from 'vitest'
import { isProviderUsageLimitText } from './provider-usage-limit-text'

describe('isProviderUsageLimitText', () => {
  it.each([
    "You've hit your session limit · resets 1:59pm",
    "You've hit your weekly limit · resets 9am (America/New_York)",
    "You've hit your monthly spend limit · resets Oct 1",
    "You've reached your Fable limit. Switch to another model or try again later.",
    "You've reached your monthly fair-use budget — purchase a credit pack to continue",
    "You're out of extra usage · resets 3pm",
    "You've hit your usage limit"
  ])('recognizes an account usage wall: %s', (text) => {
    expect(isProviderUsageLimitText(text)).toBe(true)
  })

  it.each([
    'rate_limit_error',
    "You've reached your context limit",
    'You hit your max output token limit',
    'Process exited unexpectedly'
  ])('leaves transient and non-account limits alone: %s', (text) => {
    expect(isProviderUsageLimitText(text)).toBe(false)
  })
})
