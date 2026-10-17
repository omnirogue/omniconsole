import { describe, expect, it } from 'vitest'
import {
  isSessionManageMarkedPrompt,
  sessionManagePromptMarker,
  sessionManageQuestionMarker
} from './session-manage-types'

describe('prompts another session or the steward sent', () => {
  it('reads their markers, never the person’s own words', () => {
    expect(
      isSessionManageMarkedPrompt(`${sessionManagePromptMarker('Session steward')}Carry on.`)
    ).toBe(true)
    expect(
      isSessionManageMarkedPrompt(
        `${sessionManageQuestionMarker('Session steward', 'q-d26a02e4')}Write a handoff.`
      )
    ).toBe(true)
    expect(isSessionManageMarkedPrompt('  [from Checkout fix] Please review.')).toBe(true)
    expect(isSessionManageMarkedPrompt('Fix the [from] parser')).toBe(false)
    expect(isSessionManageMarkedPrompt('[Question] why?')).toBe(false)
    expect(isSessionManageMarkedPrompt(null)).toBe(false)
  })
})
