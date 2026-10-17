import { describe, expect, it } from 'vitest'
import { detectConversationalDispatchRequest as detect } from './session-dispatch-intent'

describe('new objective conversation dispatch', () => {
  it.each([
    'Research the best database options for our reporting service',
    'Please build a weekly reporting dashboard for the support team',
    'Can you audit the model router and identify unused integrations'
  ])('routes a self-contained first objective: %s', (text) => {
    expect(detect(text, '')).toEqual({ request: text })
    expect(detect(text, 'User: existing work')).toBeNull()
  })
  it('keeps goal-framed follow-ups with their current owner and preserves first-message pins', () => {
    const text = 'I want you to research the calendar integration using Opus at high effort'
    expect(detect(text, 'User: earlier work')).toBeNull()
    expect(detect(text, '')).toEqual({ request: text })
  })
  it.each([
    'Fix this bug and update the existing tests',
    'Continue building the weekly reporting dashboard for the support team',
    'Now research the best database options for our reporting service',
    'What database should we use for the reporting service?',
    '> I want you to research the calendar integration using Opus',
    '```I want you to build an independent billing dashboard```',
    'agent: create sessions for the calendar and reporting projects',
    'I want you to research database options in this conversation',
    'Please research database options but do not dispatch new sessions',
    '/queue add research the best database options'
  ])('leaves questions, continuations, quotes and execution overrides alone: %s', (text) => {
    expect(detect(text, '')).toBeNull()
  })
  it('turns off automatic intake without disabling explicit dispatch', () => {
    expect(
      detect('Research the best database options for our reporting service', '', false)
    ).toBeNull()
    expect(
      detect('create sessions for the calendar and reporting projects', '', false)
    ).not.toBeNull()
  })
})
