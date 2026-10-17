import { describe, expect, it } from 'vitest'
import { formatSessionQuestions } from './session-questions'

describe('omni session questions (text)', () => {
  it('prints each session, its question and numbered options', () => {
    expect(
      formatSessionQuestions({
        questions: [
          {
            paneKey: 'tab-1:leaf-1',
            title: 'Checkout fix',
            agent: 'claude',
            askedAt: 1,
            toolUseId: 'toolu_01',
            sessionId: null,
            questions: [
              {
                question: 'Which env?',
                multiSelect: true,
                options: [{ label: 'dev' }, { label: 'prod' }]
              }
            ]
          }
        ]
      })
    ).toBe('Checkout fix (tab-1:leaf-1)\n  Which env? [choose several]\n    1. dev   2. prod')
    expect(formatSessionQuestions({ questions: [] })).toBe('No session is waiting on a question.')
  })
})
