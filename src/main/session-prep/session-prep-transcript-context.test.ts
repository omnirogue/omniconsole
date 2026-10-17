import { describe, expect, it } from 'vitest'
import { claudeTranscriptContext } from './session-prep-transcript-context'

const row = (value: unknown) => JSON.stringify(value)

describe('claudeTranscriptContext', () => {
  it('keeps the person and agent text, oldest first, and skips tools, meta and harness text', () => {
    const raw = [
      '{"type":"assistant","message":{"role":"assist', // cut first line of a tail read
      row({ type: 'user', message: { role: 'user', content: 'please look at billing' } }),
      row({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will check the invoice path.' },
            { type: 'tool_use', name: 'Read', input: {} }
          ]
        }
      }),
      row({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }
      }),
      row({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta text' } }),
      row({
        type: 'user',
        message: { role: 'user', content: '<system-reminder>noise</system-reminder>' }
      }),
      row({ type: 'user', message: { role: 'user', content: 'also the badge\nand the docs' } })
    ].join('\n')

    expect(claudeTranscriptContext(raw)).toBe(
      [
        'User: please look at billing',
        'Assistant: I will check the invoice path.',
        'User: also the badge',
        '  and the docs'
      ].join('\n')
    )
  })

  it('keeps only the newest whole entries within the limit', () => {
    const raw = [
      row({ type: 'user', message: { role: 'user', content: 'aaaa' } }),
      row({ type: 'user', message: { role: 'user', content: 'bbbb' } })
    ].join('\n')
    expect(claudeTranscriptContext(raw, 12)).toBe('User: bbbb')
  })
})
