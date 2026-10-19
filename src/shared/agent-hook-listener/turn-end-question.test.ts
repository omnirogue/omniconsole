import { describe, expect, it } from 'vitest'
import { parseAskFromStatus } from '../native-chat-ask'
import { detectTurnEndAsyncAsk } from './turn-end-question'
import { trimUrl } from './turn-end-sign-in-links'

const TOKEN = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(19)}_`
const LIVE = `https://live.airtop.ai/d55ab91a-1066-4a53-acc9-ac908b5348f9?disableResize=false&token=${TOKEN}`

function ask(text: string, generalQuestions = false) {
  const prompt = detectTurnEndAsyncAsk(text, text, { generalQuestions, nowMs: 1 })
  return prompt ? parseAskFromStatus(prompt) : null
}

function questionText(text: string, generalQuestions = false): string | undefined {
  return ask(text, generalQuestions)?.questions[0]?.question
}

describe('turn-end sign-in links', () => {
  it('hands over a live view the reply asks the person to sign in at, its token byte for byte', () => {
    const found = ask(`Zapier: ${LIVE}\n\nPlease sign in there, then let me know once you're done.`)
    expect(found?.delivery).toBe('async')
    expect(found?.questions[0]?.question).toContain(`Zapier: ${LIVE}`)
    expect(found?.questions[0]?.options.map((option) => option.label)).toEqual([
      'Signed in — continue',
      'Need fresh sign-in link'
    ])
  })

  it('spots an uppercase AirTop link', () => {
    const upper = LIVE.replace('https://live.airtop.ai', 'HTTPS://LIVE.AIRTOP.AI')
    expect(questionText(`Please sign in here: ${upper}`)).toContain(upper)
  })

  it.each([
    [
      'a fenced example',
      `Example payload:\n\n\`\`\`json\n{"url": "${LIVE}"}\n\`\`\`\n\nLet me know when you're ready.`
    ],
    ['inline code', `The live view looks like \`${LIVE}\`. Let me know once you're done.`],
    [
      'a quoted line',
      `> Please sign in at ${LIVE}\n\nThat was the old message; I am monitoring CI.`
    ],
    ['monitoring prose', 'I am monitoring CI. The login bug is fixed: https://example.com/login.'],
    ['a closed session', `Closed the AirTop session ${LIVE} after the run.`]
  ])('asks nothing for %s', (_name, text) => {
    expect(ask(text)).toBeNull()
  })

  it('surfaces an explicit sign-in wait with no link, but not a review request', () => {
    expect(
      questionText(
        'Please sign in to Google in the browser window, then let me know once you are done.'
      )
    ).toMatch(/^Sign in, then continue:/)
    expect(ask('Please approve the PR and let me know when you are done.')).toBeNull()
  })
})

describe('a sign-in link keeps its bytes', () => {
  it.each([
    ['https://example.com/login?code=abc_', '', 'https://example.com/login?code=abc_'],
    ['https://example.com/login?code=abc_.', '', 'https://example.com/login?code=abc_'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', '', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://example.com/login)', '](', 'https://example.com/login'],
    ['https://example.com/login?code=a_**', ' **', 'https://example.com/login?code=a_'],
    ['https://example.com/login?code=a__', ' _', 'https://example.com/login?code=a_'],
    ['https://example.com/login?state=x-', '', 'https://example.com/login?state=x-']
  ])('%s after %j', (raw, before, expected) => {
    expect(trimUrl(raw, before)).toBe(expected)
  })
})

describe('turn-end questions (Settings › Sessions, off by default)', () => {
  it('asks nothing for a plain question while the setting is off', () => {
    expect(ask('Done with the refactor. Should I merge it now?')).toBeNull()
  })

  it('asks the question the reply ends on once switched on', () => {
    expect(questionText('Done with the refactor.\n\nShould I merge it now?', true)).toBe(
      'Done with the refactor.\n\nShould I merge it now?'
    )
  })

  it('keeps a short question that asks the person', () => {
    expect(questionText('Which one?', true)).toBe('Which one?')
  })

  it.each([
    ['inline code', 'The UI now displays `Would you like to continue?`'],
    ['quoted words', 'The dialog now says "Would you like to continue?"'],
    ['curly quotes', 'The dialog now says “Would you like to continue?”'],
    ['an open code block', 'Example:\n\n```\nAre you sure?']
  ])('ignores a question inside %s', (_name, text) => {
    expect(ask(text, true)).toBeNull()
  })
})
