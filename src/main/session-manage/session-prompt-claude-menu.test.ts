import { describe, expect, it } from 'vitest'
import { selectSessionAnswer } from './session-answer-selection'
import { parseSessionPromptScreen } from './session-prompt-screen'

const question = {
  header: 'Test marker',
  question: 'Fleet question 192f3e7d2a24: pick the test marker',
  multiSelect: false,
  options: [
    { label: 'Blue', description: 'Choose Blue as the test marker' },
    { label: 'Green', description: 'Choose Green as the test marker' }
  ]
}
const hook = JSON.stringify({ questions: [question] })
// Captured on MW0003, Claude Code 2.1.285; one question, no preview or checkbox choices.
const screen = [
  '☐ Test marker',
  question.question,
  '❯ 1. Blue',
  '    Choose Blue as the test marker',
  '  2. Green',
  '    Choose Green as the test marker',
  '  3. Type something.',
  '─'.repeat(80),
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n')

function parse(text = screen, reported = hook) {
  return parseSessionPromptScreen('claude', text, reported)
}

describe('Claude native single-choice menu', () => {
  it('binds the exact screen to its hook and exposes only the declared answer digits', () => {
    const result = parse()!
    expect(result).toMatchObject({
      readable: true,
      subject: question.question,
      commandText: ['Test marker'],
      ask: { kind: 'question' },
      options: [
        { n: 1, label: 'Blue\nChoose Blue as the test marker', value: '1' },
        { n: 2, label: 'Green\nChoose Green as the test marker', value: '2' }
      ]
    })
    const prompt = {
      ...result,
      delivery: { kind: 'pty' as const, handle: 't', ptyId: 'p', screen }
    }
    expect(
      selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, { kind: 'cli' })
    ).toMatchObject({ value: '1' })
    expect(() =>
      selectSessionAnswer(prompt, { kind: 'choose', choice: 3 }, { kind: 'cli' })
    ).toThrow('not offered')
    expect(() =>
      selectSessionAnswer(prompt, { kind: 'choose', choice: 4 }, { kind: 'cli' })
    ).toThrow('not offered')
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'require a permission'
    )
  })

  it('keeps the fingerprint stable when the selection moves, and binds the hook header', () => {
    const moved = screen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.')
    expect(parse(moved)?.ask.fingerprint).toBe(parse()?.ask.fingerprint)
    const renamed = { ...question, header: 'Different marker' }
    expect(
      parse(
        screen.replace('☐ Test marker', '☐ Different marker'),
        JSON.stringify({ questions: [renamed] })
      )?.ask.fingerprint
    ).not.toBe(parse()?.ask.fingerprint)
  })

  it.each([
    ['', 'no hook'],
    ['not json', 'malformed hook'],
    [
      JSON.stringify({ questions: [{ ...question, question: 'A different question?' }] }),
      'different question'
    ],
    [JSON.stringify({ questions: [{ ...question, header: 'Other header' }] }), 'different header'],
    [
      JSON.stringify({
        questions: [{ ...question, options: [{ label: 'Blue' }, question.options[1]] }]
      }),
      'missing description'
    ],
    [JSON.stringify({ questions: [{ ...question, multiSelect: true }] }), 'multi-select'],
    [JSON.stringify({ questions: [question, question] }), 'multiple questions'],
    [
      JSON.stringify({
        questions: [
          {
            ...question,
            options: [{ ...question.options[0], preview: 'Preview' }, question.options[1]]
          }
        ]
      }),
      'preview'
    ]
  ])('refuses %s (%s)', (reported) => {
    expect(parse(screen, reported)).toBeNull()
  })

  it.each([
    screen.replace('1. Blue', '1. Red'),
    screen.replace('Choose Blue as the test marker', 'Choose a different marker'),
    screen.replace('☐ Test marker', '☒ Test marker'),
    screen.replace('☐ Test marker', '☐ Other question\n☐ Test marker'),
    screen.replace('☐ Test marker', '← ☐ Test marker ☐ Other ✔ Submit →'),
    screen.replace('1. Blue', '1. [ ] Blue'),
    screen.replace('3. Type something.', '3. Something else'),
    screen.replace('4. Chat about this', '5. Chat about this'),
    screen.replace('─'.repeat(80), 'Unknown panel'),
    screen.replace('❯ 1.', '  1.'),
    screen.replace('  2.', '❯ 2.'),
    screen.replace('Esc to cancel', 'Tab to switch questions · Esc to cancel'),
    `${screen}\ncloud@host % `
  ])('refuses an unverified menu shape', (text) => {
    expect(parse(text)).toBeNull()
  })

  it.each([
    { ...question, header: 'Test mark…' },
    { ...question, question: 'Fleet question…' },
    {
      ...question,
      options: [{ ...question.options[0], description: 'Choose Blue…' }, question.options[1]]
    }
  ])('refuses matching but truncated hook and screen text', (reported) => {
    const text = screen
      .replace(`☐ ${question.header}`, `☐ ${reported.header}`)
      .replace(question.question, reported.question)
      .replace(question.options[0]!.description, reported.options[0]!.description)
    expect(parse(text, JSON.stringify({ questions: [reported] }))).toBeNull()
  })

  it('does not normalize the same chrome for Codex or permission hooks', () => {
    expect(parseSessionPromptScreen('codex', screen, hook)).toBeNull()
    expect(parse(screen, JSON.stringify({ approval: { tool: 'Bash', summary: 'pwd' } }))).toBeNull()
  })
})
