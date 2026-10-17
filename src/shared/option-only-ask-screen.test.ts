import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AskPrompt } from './native-chat-ask-types'
import { optionOnlyAskScreenAgent, readOptionOnlyAskScreen } from './option-only-ask-screen'

// Raw `tmux capture-pane` text of the real TUIs (Gemini CLI 0.61.0, Qwen Code 0.22.3, Hermes 0.21.5).
const screen = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', 'option-only-ask-screens', `${name}.txt`), 'utf8')

const ask = (...questions: string[]): AskPrompt => ({
  questions: questions.map((question) => ({
    question,
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }]
  }))
})
const FRUIT = ask('Which fruit?')
// Why headers: Qwen's Submit tab is matched by this prompt's own tab row (every real ask has them).
const FRUIT_OCEAN: AskPrompt = {
  questions: ask('Which fruit?', 'Which ocean?').questions.map((q, i) => ({
    ...q,
    header: ['Fruit', 'Ocean'][i]
  }))
}

describe('readOptionOnlyAskScreen on live captures', () => {
  it.each([
    ['gemini', 'gemini-single', FRUIT],
    ['gemini', 'gemini-batch', FRUIT_OCEAN],
    ['qwen', 'qwen-single', FRUIT],
    ['qwen', 'qwen-batch', FRUIT_OCEAN],
    ['hermes', 'hermes-single', FRUIT],
    ['hermes', 'hermes-batch', FRUIT_OCEAN]
  ] as const)('%s: finds the open dialog on its first question (%s)', (agent, name, prompt) => {
    expect(readOptionOnlyAskScreen(agent, screen(name), prompt)).toBe(0)
  })

  it.each([
    ['gemini', 'gemini-after-esc', FRUIT],
    ['gemini', 'gemini-after-esc', FRUIT_OCEAN],
    ['qwen', 'qwen-after-esc', FRUIT],
    ['qwen', 'qwen-after-esc', FRUIT_OCEAN],
    ['qwen', 'qwen-after-approval-esc', FRUIT],
    // Why: another tool's confirmation owns the digits even though a question is pending.
    ['qwen', 'qwen-shell-approval', FRUIT],
    ['qwen', 'qwen-shell-approval', FRUIT_OCEAN],
    ['hermes', 'hermes-after-esc', FRUIT]
  ] as const)('%s: refuses %s (cancelled or covered)', (agent, name, prompt) => {
    expect(readOptionOnlyAskScreen(agent, screen(name), prompt)).toBeNull()
  })

  it('refuses a dialog for a different question, and a missing screen', () => {
    expect(readOptionOnlyAskScreen('qwen', screen('qwen-single'), ask('Which ocean?'))).toBeNull()
    expect(readOptionOnlyAskScreen('gemini', screen('gemini-single'), ask('Pick one'))).toBeNull()
    expect(readOptionOnlyAskScreen('hermes', null, FRUIT)).toBeNull()
  })

  it('refuses another agent’s dialog', () => {
    expect(readOptionOnlyAskScreen('gemini', screen('qwen-single'), FRUIT)).toBeNull()
    expect(readOptionOnlyAskScreen('qwen', screen('hermes-single'), FRUIT)).toBeNull()
  })
})

describe('readOptionOnlyAskScreen steps', () => {
  it.each([
    ['qwen', 'qwen-batch-second', 1],
    ['qwen', 'qwen-batch-submit', 'submit'],
    ['gemini', 'gemini-review', 'submit'],
    ['hermes', 'hermes-batch-second', 1]
  ] as const)('%s: reads the live step screen %s', (agent, name, step) => {
    expect(readOptionOnlyAskScreen(agent, screen(name), FRUIT_OCEAN)).toBe(step)
  })

  it('keeps the Qwen Submit tab strict', () => {
    const submit = screen('qwen-batch-submit')
    const headed = FRUIT_OCEAN
    expect(readOptionOnlyAskScreen('qwen', submit, headed)).toBe('submit')
    // Another prompt's tab row, or another confirmation after the header, is not this Submit.
    const other: AskPrompt = {
      questions: headed.questions.map((q, i) => ({ ...q, header: ['Color', 'Size'][i] }))
    }
    const unheaded = ask('Which fruit?', 'Which ocean?')
    expect(readOptionOnlyAskScreen('qwen', submit, unheaded)).toBeNull()
    expect(readOptionOnlyAskScreen('qwen', submit, other)).toBeNull()
    expect(
      readOptionOnlyAskScreen(
        'qwen',
        submit.replace('Ready to submit your answers?', "Allow execution of: 'touch'?"),
        headed
      )
    ).toBeNull()
    expect(
      readOptionOnlyAskScreen(
        'qwen',
        submit.replace('❯ 1. Submit answers', '  1. Submit answers'),
        headed
      )
    ).toBeNull()
  })

  it('matches a question the pane width wrapped', () => {
    const long = 'Which deployment target should this release use for the canary rollout?'
    const wrapped = screen('qwen-single').replace(
      '   Which fruit?\n',
      '   Which deployment target should this release\n   use for the canary rollout?\n'
    )
    expect(readOptionOnlyAskScreen('qwen', wrapped, ask(long))).toBe(0)
  })
})

// Derived from the live captures by substituting only the question text (the chrome stays real).
describe('readOptionOnlyAskScreen with questions that share an opening', () => {
  const API = 'Which database should we use for the API service?'
  const ANALYTICS = 'Which database should we use for the analytics jobs?'
  const SHORT = 'Which database?'
  const LONGER = 'Which database? The one for analytics'
  const pair = (first: string, second: string): AskPrompt => ({
    questions: [first, second].map((question, index) => ({
      question,
      header: ['Fruit', 'Ocean'][index],
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }]
    }))
  })
  const hermes = (name: string, first: string, second: string) =>
    screen(name).replaceAll('Which fruit?', first).replaceAll('Which ocean?', second)
  const qwenLine = (name: string, from: string, to: string) =>
    screen(name).replace(`   ${from}\n`, `   ${to}\n`)
  const geminiLine = (name: string, to: string) =>
    screen(name).replace(/│ Which fruit\?\s+│/, `│ ${to} │`)

  it.each([
    [API, ANALYTICS],
    [SHORT, LONGER],
    [LONGER, SHORT]
  ])('Hermes: tells "%s" from "%s" on both steps', (first, second) => {
    const prompt = pair(first, second)
    expect(readOptionOnlyAskScreen('hermes', hermes('hermes-batch', first, second), prompt)).toBe(0)
    expect(
      readOptionOnlyAskScreen('hermes', hermes('hermes-batch-second', first, second), prompt)
    ).toBe(1)
  })

  it.each([
    [API, ANALYTICS],
    [SHORT, LONGER],
    [LONGER, SHORT]
  ])('Qwen: tells "%s" from "%s" on both tabs', (first, second) => {
    const prompt = pair(first, second)
    expect(
      readOptionOnlyAskScreen('qwen', qwenLine('qwen-batch', 'Which fruit?', first), prompt)
    ).toBe(0)
    expect(
      readOptionOnlyAskScreen('qwen', qwenLine('qwen-batch-second', 'Which ocean?', second), prompt)
    ).toBe(1)
  })

  it('Qwen: refuses a question whose tab marker disagrees', () => {
    // Tab row "▸ Fruit" but question 2's text: not a state to type into.
    const screenText = qwenLine('qwen-batch', 'Which fruit?', ANALYTICS)
    expect(readOptionOnlyAskScreen('qwen', screenText, pair(API, ANALYTICS))).toBeNull()
  })

  it('Gemini: tells same-opening questions apart', () => {
    const prompt = pair(API, ANALYTICS)
    expect(readOptionOnlyAskScreen('gemini', geminiLine('gemini-batch', API), prompt)).toBe(0)
    expect(readOptionOnlyAskScreen('gemini', geminiLine('gemini-batch', ANALYTICS), prompt)).toBe(1)
    expect(
      readOptionOnlyAskScreen('gemini', geminiLine('gemini-batch', SHORT), pair(LONGER, SHORT))
    ).toBe(1)
  })

  it('refuses identical questions and a batch without headers', () => {
    expect(
      readOptionOnlyAskScreen('hermes', screen('hermes-batch'), ask('Which fruit?', 'Which fruit?'))
    ).toBeNull()
    expect(
      readOptionOnlyAskScreen('qwen', screen('qwen-batch'), ask('Which fruit?', 'Which ocean?'))
    ).toBeNull()
  })
})

// Derived from the live captures by moving the highlight onto the free-text row.
describe('readOptionOnlyAskScreen with the highlight on the free-text row', () => {
  it.each([
    [
      'qwen',
      'qwen-single',
      ['❯ 1. Apple', '  1. Apple'],
      ['  4. Type something...', '❯ 4. Type something...']
    ],
    [
      'hermes',
      'hermes-single',
      ['▸ 1. Apple', '  1. Apple'],
      ['  4. Other (type your answer)', '▸ 4. Other (type your answer)']
    ],
    [
      'gemini',
      'gemini-single',
      ['● 1.  Apple', '  1.  Apple'],
      ['  3.  Cherry', '● 4.  Enter a custom value']
    ]
  ] as const)('%s: refuses, since a digit there becomes typed text', (agent, name, off, on) => {
    const moved = screen(name).replace(off[0], off[1]).replace(on[0], on[1])
    expect(readOptionOnlyAskScreen(agent, screen(name), FRUIT)).toBe(0)
    expect(readOptionOnlyAskScreen(agent, moved, FRUIT)).toBeNull()
  })
})

// Edited from the live gemini-single capture: only the question line (as Gemini's inline markdown
// renderer draws it) or the highlighted row changes.
describe('readOptionOnlyAskScreen on Gemini-rendered markdown and placeholders', () => {
  const shown = (text: string) =>
    screen('gemini-single').replace(/│ Which fruit\?\s+│/, `│ ${text} │`)

  it.each([
    ['Should I use `pnpm` or **npm**?', 'Should I use pnpm or npm?'],
    [
      'Read [the docs](https://example.com/docs) first?',
      'Read the docs (https://example.com/docs) first?'
    ],
    ['Is this *really* __done__ ~~yet~~?', 'Is this really done yet?'],
    ['Keep my_var_name as is?', 'Keep my_var_name as is?']
  ])('matches %s as Gemini draws it', (question, rendered) => {
    expect(readOptionOnlyAskScreen('gemini', shown(rendered), ask(question))).toBe(0)
    // The raw markdown is not what Gemini shows, so it must not be required.
    expect(readOptionOnlyAskScreen('gemini', shown(rendered), ask(rendered))).toBe(0)
  })

  it('refuses when the highlight is on a custom row showing the question’s placeholder', () => {
    const prompt: AskPrompt = {
      questions: [
        { ...FRUIT.questions[0]!, question: 'Which fruit?', placeholder: 'Type a `fruit`' }
      ]
    }
    const custom = screen('gemini-single')
      .replace('● 1.  Apple', '  1.  Apple')
      .replace('  3.  Cherry', '● 4.  Type a fruit')
    expect(readOptionOnlyAskScreen('gemini', screen('gemini-single'), prompt)).toBe(0)
    expect(readOptionOnlyAskScreen('gemini', custom, prompt)).toBeNull()
  })
})

describe('optionOnlyAskScreenAgent', () => {
  it('maps only the option-only agents', () => {
    expect(optionOnlyAskScreenAgent('gemini')).toBe('gemini')
    expect(optionOnlyAskScreenAgent('qwen-code')).toBe('qwen')
    expect(optionOnlyAskScreenAgent('hermes')).toBe('hermes')
    expect(optionOnlyAskScreenAgent('claude')).toBeNull()
  })
})
