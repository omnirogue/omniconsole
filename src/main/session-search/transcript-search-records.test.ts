import { describe, expect, it } from 'vitest'
import { readTranscriptLine } from './transcript-search-records'

const line = (value: unknown): string => JSON.stringify(value)

describe('readTranscriptLine (claude)', () => {
  it('reads asks, replies, tool calls and tool output', () => {
    const ask = readTranscriptLine(
      'claude',
      line({
        type: 'user',
        timestamp: '2026-09-24T10:00:00Z',
        cwd: '/w',
        message: { content: 'Hand the CI backlog to Uma' }
      })
    )
    expect(ask?.records).toEqual([
      { role: 'user', text: 'Hand the CI backlog to Uma', ts: Date.parse('2026-09-24T10:00:00Z') }
    ])
    expect(ask?.cwd).toBe('/w')
    const reply = readTranscriptLine(
      'claude',
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Done' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'gh pr list', description: 'List PRs' }
            }
          ]
        }
      })
    )
    expect(reply?.records.map((record) => [record.role, record.text])).toEqual([
      ['assistant', 'Done'],
      ['tool', 'Bash List PRs gh pr list']
    ])
    const output = readTranscriptLine(
      'claude',
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(5_000) }] }]
        }
      })
    )
    expect(output?.records[0]!.role).toBe('tool')
    expect(output?.records[0]!.text.length).toBeLessThan(3_000)
  })

  it('ignores hook-injected attachments and harness turns', () => {
    expect(
      readTranscriptLine(
        'claude',
        line({ type: 'attachment', attachment: { content: 'Uma owns merges' } })
      )?.records
    ).toEqual([])
    expect(
      readTranscriptLine(
        'claude',
        line({ type: 'user', message: { content: '<system-reminder>memo</system-reminder>' } })
      )?.records
    ).toEqual([])
    const mixed = readTranscriptLine(
      'claude',
      line({
        type: 'user',
        message: { content: 'real ask <system-reminder>injected Uma</system-reminder>' }
      })
    )
    expect(mixed?.records[0]!.text).toBe('real ask')
  })

  it('ranks titles: the person’s name beats a generated one', () => {
    expect(
      readTranscriptLine('claude', line({ type: 'custom-title', customTitle: 'Mine' }))?.title
    ).toEqual({ text: 'Mine', rank: 3 })
    expect(
      readTranscriptLine('claude', line({ type: 'ai-title', aiTitle: 'Generated' }))?.title?.rank
    ).toBe(2)
  })

  it('records pull request links', () => {
    const facts = readTranscriptLine(
      'claude',
      line({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/7' })
    )
    expect(facts?.links).toEqual(['https://github.com/o/r/pull/7'])
  })

  it('returns null for a line that is not JSON', () => {
    expect(readTranscriptLine('claude', '{"type":')).toBeNull()
  })
})

describe('readTranscriptLine (codex)', () => {
  const item = (payload: unknown): string =>
    line({ type: 'response_item', timestamp: '2026-09-24T10:00:00Z', payload })

  it('skips injected context and developer messages', () => {
    expect(
      readTranscriptLine(
        'codex',
        item({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }]
        })
      )?.records
    ).toEqual([])
    expect(
      readTranscriptLine(
        'codex',
        item({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'rules' }]
        })
      )?.records
    ).toEqual([])
    expect(
      readTranscriptLine(
        'codex',
        line({ type: 'world_state', payload: { state: { agents_md: { text: 'Uma' } } } })
      )?.records
    ).toEqual([])
  })

  it('reads asks, replies, calls and unwrapped shell output', () => {
    expect(
      readTranscriptLine(
        'codex',
        item({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix the deploy' }]
        })
      )?.records[0]!.text
    ).toBe('Fix the deploy')
    expect(
      readTranscriptLine(
        'codex',
        item({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fixed' }]
        })
      )?.records[0]!.role
    ).toBe('assistant')
    expect(
      readTranscriptLine(
        'codex',
        item({ type: 'function_call', name: 'shell', arguments: '{"command":"git push"}' })
      )?.records[0]!.text
    ).toBe('shell git push')
    expect(
      readTranscriptLine(
        'codex',
        item({ type: 'function_call_output', output: '{"output":"pushed prod-omnirogue"}' })
      )?.records[0]!.text
    ).toBe('pushed prod-omnirogue')
  })

  it('takes the working folder from session metadata', () => {
    expect(
      readTranscriptLine('codex', line({ type: 'session_meta', payload: { cwd: '/repo' } }))?.cwd
    ).toBe('/repo')
  })
})
