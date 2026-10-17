import { describe, expect, it } from 'vitest'
import { classifyAgentTurnFailure, describeAgentTurnFailure } from './agent-turn-failure'

describe('provider interruption reasons', () => {
  it.each([
    "You've hit your limit",
    'rate_limit_error',
    'Your credit balance is too low to access the Anthropic API',
    'Insufficient credits. This account needs more credits.',
    'Insufficient balance',
    'Credits exhausted',
    '402 Payment Required',
    "You've hit your session limit · resets 1:59pm",
    "You've hit your weekly limit · resets 9am (America/New_York)",
    "You've hit your monthly spend limit · resets Oct 1",
    "You've reached your Fable limit. Switch to another model or try again later.",
    "You've reached your Fable 5 limit",
    'You’ve hit your usage limit',
    "You've reached your monthly fair-use budget — purchase a credit pack to continue",
    "You're out of extra usage · resets 3pm"
  ])('recognizes capacity rejection: %s', (reason) => {
    expect(classifyAgentTurnFailure(reason)).toBe('usage-limit')
    expect(describeAgentTurnFailure(reason)).toContain(reason)
    expect(describeAgentTurnFailure(reason)).not.toContain('switch that account’s model')
  })

  it('keeps expired authentication separate from capacity and unknown failures', () => {
    expect(classifyAgentTurnFailure('OAuth token expired')).toBe('authentication')
    expect(classifyAgentTurnFailure('Process exited unexpectedly')).toBe('unknown')
    expect(classifyAgentTurnFailure("You've reached your context limit")).toBe('unknown')
    expect(classifyAgentTurnFailure('You hit your max output token limit')).toBe('unknown')
    expect(classifyAgentTurnFailure('The file you reached exceeds the size limit')).toBe('unknown')
    expect(classifyAgentTurnFailure(undefined)).toBe('unknown')
  })
})
