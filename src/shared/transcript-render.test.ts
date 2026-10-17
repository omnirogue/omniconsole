import { describe, expect, it } from 'vitest'
import {
  renderTranscriptMarkdown,
  transcriptSourceLength,
  TRANSCRIPT_SOURCE_MAX_NODES,
  transcriptByteLength,
  transcriptTruncationMarker,
  TRANSCRIPT_TOOL_INPUT_HEAD_BYTES,
  TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES
} from './transcript-render'
import type { NativeChatMessage } from './native-chat-types'

const options = {
  agent: 'claude',
  model: 'opus-5',
  sessionId: 'ses_abc123',
  capturedAt: '2026-09-13T09:30:00.000Z',
  sourceDigest: 'a'.repeat(64),
  // A stand-in digest keeps the renderer pure and the expectations exact.
  sha256: (value: string) => `d${transcriptByteLength(value).toString(16).padStart(15, '0')}`
}

function message(partial: Partial<NativeChatMessage>): NativeChatMessage {
  return {
    id: 'm1',
    role: 'user',
    blocks: [{ type: 'text', text: 'hello' }],
    timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
    source: 'transcript',
    ...partial
  }
}

describe('renderTranscriptMarkdown', () => {
  it('renders a header, one section per message and a footer', () => {
    const result = renderTranscriptMarkdown(
      [
        message({ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'Ship the thing.' }] }),
        message({
          id: 'm2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Done.' }],
          timestamp: Date.UTC(2026, 8, 13, 9, 1, 0)
        })
      ],
      options
    )
    expect(result.messageCount).toBe(2)
    expect(result.truncatedBlocks).toBe(0)
    expect(result.markdown).toContain('# Session transcript')
    expect(result.markdown).toContain('- Agent: claude')
    expect(result.markdown).toContain('- Model: opus-5')
    expect(result.markdown).toContain('- Session: ses_abc123')
    expect(result.markdown).toContain('- Captured at: 2026-09-13T09:30:00.000Z')
    expect(result.markdown).toContain('- Messages: 2')
    expect(result.markdown).toContain(`- Source digest: ${'a'.repeat(64)}`)
    expect(result.markdown).toContain('## 1. Person — 2026-09-13T09:00:00.000Z')
    expect(result.markdown).toContain('## 2. Agent — 2026-09-13T09:01:00.000Z')
    expect(result.markdown).toContain('every message is complete')
    expect(result.bytes).toBe(transcriptByteLength(result.markdown))
  })

  it('is deterministic for the same capture', () => {
    const messages = [message({}), message({ id: 'm2', role: 'assistant' })]
    expect(renderTranscriptMarkdown(messages, options).markdown).toBe(
      renderTranscriptMarkdown(messages, options).markdown
    )
  })

  it('renders a tool call with its name and a fenced input', () => {
    const result = renderTranscriptMarkdown(
      [
        message({
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'read_file', input: { path: 'src/index.ts' } }]
        })
      ],
      options
    )
    expect(result.markdown).toContain('Tool call: read_file')
    expect(result.markdown).toContain('```json')
    expect(result.markdown).toContain('"path": "src/index.ts"')
  })

  it('renders a tool result and marks an error result', () => {
    const result = renderTranscriptMarkdown(
      [
        message({
          role: 'tool',
          blocks: [{ type: 'tool-result', output: 'exit 1: not found', isError: true }]
        })
      ],
      options
    )
    expect(result.markdown).toContain('Tool error:')
    expect(result.markdown).toContain('exit 1: not found')
  })

  it('cannot be escaped by tool output that contains a fence', () => {
    const result = renderTranscriptMarkdown(
      [message({ role: 'tool', blocks: [{ type: 'tool-result', output: '```\nnested\n```' }] })],
      options
    )
    expect(result.markdown).toContain('````\n```\nnested\n```\n````')
  })

  it('clips a long tool result to its head and marks it with a digest', () => {
    const output = 'x'.repeat(TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES + 500)
    const result = renderTranscriptMarkdown(
      [message({ role: 'tool', blocks: [{ type: 'tool-result', output }] })],
      options
    )
    expect(result.truncatedBlocks).toBe(1)
    expect(result.markdown).toContain(
      transcriptTruncationMarker(output.length, options.sha256(output))
    )
    expect(result.markdown).toContain('bytes total, digest')
    expect(result.markdown).not.toContain('x'.repeat(TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES + 1))
    expect(result.markdown).toContain('1 tool payload was clipped')
  })

  it('clips a long tool call input at its own smaller bound', () => {
    const input = 'y'.repeat(TRANSCRIPT_TOOL_INPUT_HEAD_BYTES + 500)
    const result = renderTranscriptMarkdown(
      [message({ role: 'assistant', blocks: [{ type: 'tool-call', name: 'write', input }] })],
      options
    )
    expect(result.truncatedBlocks).toBe(1)
    expect(result.markdown).toContain('bytes total, digest')
    expect(result.markdown).not.toContain('y'.repeat(TRANSCRIPT_TOOL_INPUT_HEAD_BYTES + 1))
  })

  it('never splits a multi-byte character when clipping', () => {
    const output = 'é'.repeat(TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES)
    const result = renderTranscriptMarkdown(
      [message({ role: 'tool', blocks: [{ type: 'tool-result', output }] })],
      options
    )
    expect(result.markdown).not.toContain('�')
  })

  it('drops reasoning and system messages and empty messages', () => {
    const result = renderTranscriptMarkdown(
      [
        message({ role: 'reasoning', blocks: [{ type: 'text', text: 'thinking' }] }),
        message({ id: 'm2', role: 'system', blocks: [{ type: 'text', text: 'setup' }] }),
        message({ id: 'm3', role: 'user', blocks: [{ type: 'text', text: '   ' }] }),
        message({ id: 'm4', role: 'user', blocks: [{ type: 'text', text: 'kept' }] })
      ],
      options
    )
    expect(result.messageCount).toBe(1)
    expect(result.markdown).toContain('## 1. Person')
    expect(result.markdown).not.toContain('thinking')
    expect(result.markdown).not.toContain('setup')
  })

  it('labels a message with no timestamp rather than inventing one', () => {
    const result = renderTranscriptMarkdown([message({ timestamp: null })], options)
    expect(result.markdown).toContain('## 1. Person — time unknown')
  })

  it('refuses a transcript above its byte bound, naming the size', () => {
    const messages = [message({ blocks: [{ type: 'text', text: 'z'.repeat(5000) }] })]
    expect(() => renderTranscriptMarkdown(messages, { ...options, maxBytes: 1024 })).toThrow(
      /is \d+ bytes, above the 1024 byte limit/
    )
  })
})

describe('transcriptSourceLength', () => {
  function nested(depth: number, payload: string): unknown {
    let value: unknown = payload
    for (let level = 0; level < depth; level += 1) {
      value = { [`level${level}`]: value }
    }
    return value
  }

  function toolCall(input: unknown, id: string): NativeChatMessage {
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'write', input }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
  }

  it('accounts for a megabyte hidden under nine levels of nesting', () => {
    // The reviewer's case: a depth-capped walk scored these twenty inputs at
    // 260 units and let ~21 M units through to the serializer.
    const messages = Array.from({ length: 20 }, (_, index) =>
      toolCall(nested(9, 'z'.repeat(1024 * 1024)), `m${index}`)
    )
    const result = transcriptSourceLength(messages)
    expect(result.overBudget).toBe(true)
    expect(result.length).toBeGreaterThan(16 * 1024 * 1024)
  })

  it('measures a string at any depth rather than giving up on it', () => {
    const shallow = transcriptSourceLength([toolCall({ a: 'x'.repeat(1000) }, 'm1')])
    const deep = transcriptSourceLength([toolCall(nested(40, 'x'.repeat(1000)), 'm1')])
    expect(shallow.overBudget).toBe(false)
    expect(deep.overBudget).toBe(false)
    expect(deep.length).toBeGreaterThan(1000)
  })

  it('treats an input spread over more nodes than the cap as over budget', () => {
    const wide = Array.from({ length: TRANSCRIPT_SOURCE_MAX_NODES + 10 }, () => 'a')
    expect(transcriptSourceLength([toolCall(wide, 'm1')]).overBudget).toBe(true)
  })

  it('passes an ordinary session', () => {
    const result = transcriptSourceLength([
      message({ blocks: [{ type: 'text', text: 'hello' }] }),
      toolCall({ path: 'src/index.ts' }, 'm2')
    ])
    expect(result.overBudget).toBe(false)
    expect(result.length).toBeGreaterThan(0)
  })

  it('terminates on a cyclic tool input', () => {
    const cyclic: Record<string, unknown> = { name: 'x'.repeat(100) }
    cyclic.self = cyclic
    expect(transcriptSourceLength([toolCall(cyclic, 'm1')]).overBudget).toBe(false)
  })

  it('stops at the first block past the budget', () => {
    const result = transcriptSourceLength(
      [
        message({ blocks: [{ type: 'text', text: 'z'.repeat(2000) }] }),
        message({ id: 'm2', blocks: [{ type: 'text', text: 'z'.repeat(2000) }] })
      ],
      1000
    )
    expect(result.overBudget).toBe(true)
    expect(result.length).toBeLessThan(4000)
  })
})
