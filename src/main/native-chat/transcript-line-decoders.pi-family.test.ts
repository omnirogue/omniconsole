// Crafted, not captured: installs were DNS-blocked and no API key was configured.
// Shapes: badlogic/pi-mono and PrimeIntellect-ai/prime-agent, packages/coding-agent/docs/session-format.md.
// Prime tool: PrimeIntellect-ai/prime-agent, packages/coding-agent/src/core/tools/ipython.ts.
import { describe, expect, it } from 'vitest'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

const timestamp = '2026-09-15T12:00:00.000Z'
function entry(id: string, parentId: string | null, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'message', id, parentId, timestamp, message })
}

const fixtures = [
  { agent: 'pi', tool: 'bash', input: { command: 'printf 2' } },
  { agent: 'prime-agent', tool: 'ipython', input: { code: 'print(1 + 1)' } }
] as const

describe.each(fixtures)('$agent JSONL fixture', ({ agent, tool, input }) => {
  it('routes conversation and tool records through the unchanged OMP implementation', () => {
    const decode = nativeChatLineDecoderForAgent(agent)!
    expect(decode).toBe(decodeOmpTranscriptLine)
    const fixture = [
      JSON.stringify({ type: 'session', version: 3, id: 'session-id', cwd: '/project', timestamp }),
      JSON.stringify({ type: 'model_change', id: 'model', modelId: 'fixture-model', timestamp }),
      entry('user', null, { role: 'user', content: 'Calculate one plus one.' }),
      entry('call', 'user', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Use the available tool.' },
          { type: 'toolCall', id: 'tool-1', name: tool, arguments: input }
        ],
        stopReason: 'toolUse'
      }),
      entry('result', 'call', {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: tool,
        content: [{ type: 'text', text: '2' }],
        isError: false
      }),
      entry('answer', 'result', { role: 'assistant', content: [{ type: 'text', text: 'Two.' }] }),
      entry('branch', 'user', { role: 'assistant', content: [{ type: 'text', text: 'Also two.' }] })
    ]
    const messages = fixture.map((line) => decode(line, 'fallback')).filter(Boolean)
    expect(messages.map((message) => message!.id)).toEqual([
      'user',
      'call',
      'result',
      'answer',
      'branch'
    ])
    expect(messages[0]).toMatchObject({ role: 'user', timestamp: Date.parse(timestamp) })
    expect(messages[1]?.blocks).toEqual([
      { type: 'text', text: 'Use the available tool.' },
      { type: 'tool-call', name: tool, input }
    ])
    expect(messages[2]).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: '2' }]
    })
  })

  it('preserves tool failures and skips hidden extension state', () => {
    const decode = nativeChatLineDecoderForAgent(agent)!
    expect(
      decode(
        entry('error', 'call', {
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: tool,
          content: [{ type: 'text', text: 'Execution failed' }],
          isError: true
        }),
        'fallback'
      )?.blocks
    ).toEqual([{ type: 'tool-result', output: 'Execution failed', isError: true }])
    expect(
      decode(JSON.stringify({ type: 'custom_message', display: false, content: 'hidden' }), 'f')
    ).toBeNull()
    expect(decode('not json', 'f')).toBeNull()
  })
})
