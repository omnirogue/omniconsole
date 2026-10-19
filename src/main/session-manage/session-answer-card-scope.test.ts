import { describe, expect, it } from 'vitest'
import { selectSessionAnswer } from './session-answer-selection'
import { describeSessionPrompt, type SessionPrompt } from './session-prompt'

function permission(text: string): SessionPrompt {
  const options = [
    { n: 1, label: 'Allow', value: 'allow', role: 'allow-once' as const },
    { n: 2, label: 'Deny', value: 'deny', role: 'deny' as const }
  ]
  return {
    ask: describeSessionPrompt('permission', text, options, true, []),
    options,
    readable: true,
    subject: text,
    commandText: [],
    delivery: { kind: 'structured', sessionId: 'chat', itemId: 'item', fence: 1, revision: 1 }
  }
}

function question(): SessionPrompt {
  const options = [
    { n: 1, label: 'Red', value: 'q1:choice-1' },
    { n: 2, label: 'Blue', value: 'q1:choice-2' }
  ]
  return {
    ask: describeSessionPrompt('question', 'Which color?', options, true),
    options,
    readable: true,
    subject: 'Which color?',
    commandText: [],
    delivery: {
      kind: 'structured',
      sessionId: 'chat',
      itemId: 'item',
      fence: 1,
      revision: 1,
      freeTextQuestionId: 'q1'
    }
  }
}

describe('session answer: a question is checked by its card, not the scrollback', () => {
  function card(subject: string, scrollback = subject, commandText: string[] = []): SessionPrompt {
    const prompt = question()
    prompt.ask = describeSessionPrompt('question', scrollback, prompt.options, true, commandText)
    prompt.subject = subject
    prompt.commandText = commandText
    return prompt
  }
  const choose2 = { kind: 'choose' as const, choice: 2 }

  it('allows a plain card under scrollback that names hard stops and a scoped folder', () => {
    const scrollback = [
      'Review, Merge & Deploy PRs #1939',
      "do not retrieve another person's credentials",
      "write only in this session's results folder",
      'Which color?'
    ].join('\n')
    expect(
      selectSessionAnswer(card('Which color?', scrollback), choose2, { kind: 'cli' })
    ).toMatchObject({ n: 2, label: 'Blue' })
  })

  it('refuses a hard stop in the question', () => {
    expect(() =>
      selectSessionAnswer(card('Deploy to production now?'), choose2, { kind: 'cli' })
    ).toThrow('hard stop')
  })

  it('refuses a hard stop in the question header', () => {
    expect(() =>
      selectSessionAnswer(
        card('Which color?', 'Which color?', ['Delete all customer data?']),
        choose2,
        { kind: 'cli' }
      )
    ).toThrow('hard stop')
  })

  it('refuses a scoped permission in the question', () => {
    expect(() =>
      selectSessionAnswer(card('Allow for this session?'), choose2, { kind: 'cli' })
    ).toThrow('persistent or scoped')
  })

  it('still scans the whole screen of a permission prompt for --allow', () => {
    expect(() =>
      selectSessionAnswer(
        permission('Bash\ngit push --force origin main'),
        { kind: 'allow' },
        { kind: 'cli' }
      )
    ).toThrow('hard stop')
  })
})

