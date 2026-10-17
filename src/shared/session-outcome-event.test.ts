import { describe, expect, it } from 'vitest'
import {
  sessionOutcomeEventProblem,
  sessionOutcomeEventSchema,
  sessionOutcomeEventSourceLabel
} from './session-outcome-event'

describe('a session wait', () => {
  it('names the awaited session by its pane key and matches its result', () => {
    expect(
      sessionOutcomeEventSchema.parse({ source: 'session', match: 'result', ref: 'tab-2:leaf-2' })
    ).toEqual({ source: 'session', match: 'result', ref: 'tab-2:leaf-2' })
    expect(sessionOutcomeEventSourceLabel('session')).toBe('session result')
  })

  it('says what is wrong in words the filing agent can fix', () => {
    expect(sessionOutcomeEventProblem({ source: 'session', match: 'result' })).toBe(
      'A session wait needs `ref`: the pane key `omni outcome wait --on-session` printed.'
    )
    expect(
      sessionOutcomeEventProblem({ source: 'session', match: 'result', ref: 'billing session' })
    ).toContain('needs `ref`')
    expect(
      sessionOutcomeEventProblem({ source: 'session', match: 'approve', ref: 'tab-2:leaf-2' })
    ).toBe('A session wait matches result.')
    expect(
      sessionOutcomeEventProblem({
        source: 'session',
        match: 'result',
        ref: 'tab-2:leaf-2',
        personId: 'emp_uma'
      })
    ).toBe('A session wait names no person.')
    expect(sessionOutcomeEventProblem({ source: 'slack', match: 'result' })).toBe(
      'A slack wait matches approve or reply.'
    )
  })
})
