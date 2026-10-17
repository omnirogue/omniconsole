import { describe, expect, it } from 'vitest'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import { storedWorkflowLine, WORKFLOW_STORED_FIELD_LIMIT } from './workflow-stored-output'
import { parseWorkflowNativeResult } from './workflow-native-result'

const long = 'x'.repeat(WORKFLOW_STORED_FIELD_LIMIT + 500)
const clipped = `${'x'.repeat(WORKFLOW_STORED_FIELD_LIMIT)}… [500 more characters not stored]`

describe('stored workflow stdout', () => {
  it('keeps Claude answer deltas for timeout recovery alongside assistant and result lines byte for byte', () => {
    const delta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } }
    })
    expect(storedWorkflowLine('claude', delta)).toBe(delta)
    const assistant = `{"type":"assistant","message":{"content":[{"type":"text","text":"${long}"}]}}`
    expect(storedWorkflowLine('claude', assistant)).toBe(assistant)
    const result = '{"type":"result",  "result":"\\u00e9"}'
    expect(storedWorkflowLine('claude', result)).toBe(result)
  })

  it('clips Claude tool results and file echoes', () => {
    const user = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: long }] },
      tool_use_result: {
        type: 'text',
        file: { filePath: '/repo/a.ts', content: long, numLines: 9 }
      }
    }
    expect(JSON.parse(storedWorkflowLine('claude', JSON.stringify(user))!)).toEqual({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: clipped }] },
      tool_use_result: {
        type: 'text',
        file: { filePath: '/repo/a.ts', content: clipped, numLines: 9 }
      }
    })
  })

  it('clips Codex command output but never agent messages', () => {
    const command = {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'seq 1 200000', aggregated_output: long }
    }
    expect(JSON.parse(storedWorkflowLine('codex', JSON.stringify(command))!).item).toEqual({
      ...command.item,
      aggregated_output: clipped
    })
    const answer = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: long }
    })
    expect(storedWorkflowLine('codex', answer)).toBe(answer)
  })

  it('drops Grok thoughts and command lists and clips tool output', () => {
    expect(storedWorkflowLine('grok', '{"type":"thought","data":"The"}')).toBeNull()
    expect(storedWorkflowLine('grok', '{"type":"available_commands","tools":[]}')).toBeNull()
    const update = {
      type: 'tool_call_update',
      toolCallId: 'c',
      status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: { content: long } }
    }
    expect(JSON.parse(storedWorkflowLine('grok', JSON.stringify(update))!).rawOutput).toEqual({
      type: 'ReadFile',
      FileContent: { content: clipped }
    })
    const text = '{"type":"text","data":"{\\""}'
    expect(storedWorkflowLine('grok', text)).toBe(text)
  })

  it('clips the prompt Gemini echoes back but keeps answer deltas', () => {
    const user = { type: 'message', role: 'user', content: long }
    expect(JSON.parse(storedWorkflowLine('gemini', JSON.stringify(user))!).content).toBe(clipped)
    const delta = JSON.stringify({ type: 'message', role: 'assistant', content: long, delta: true })
    expect(storedWorkflowLine('gemini', delta)).toBe(delta)
  })

  it('stores anything that is not a JSON object unchanged', () => {
    for (const line of ['{', '  "stopReason": "end_turn",', '[1,2]', 'plain', '']) {
      expect(storedWorkflowLine('grok', line)).toBe(line)
    }
  })
})

describe('stored stdout stays parseable', () => {
  const markdown = {
    type: 'object',
    properties: { markdown: { type: 'string' } },
    required: ['markdown'],
    additionalProperties: false
  }
  // Recovery re-parses the stored form, so it must give the same answer as the live stream.
  const reparse = (route: LocalWorkflowRoute, events: unknown[]) => {
    const stdout = events
      .map((event) => storedWorkflowLine(route, JSON.stringify(event)))
      .filter((line) => line !== null)
      .join('\n')
    return parseWorkflowNativeResult(
      route,
      { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
      markdown,
      () => null,
      'text'
    ).value
  }

  it('keeps the Grok tool boundaries and answer text', () => {
    expect(
      reparse('grok', [
        { type: 'thought', data: 'x' },
        { type: 'text', data: 'Narration. ' },
        { type: 'tool_call', toolCallId: 'c', toolName: 'read_file', rawInput: {} },
        { type: 'tool_call_update', toolCallId: 'c', status: 'completed', content: [long] },
        { type: 'text', data: 'Answer.' },
        {
          type: 'end',
          stopReason: 'end_turn',
          sessionId: 's',
          requestId: 'r',
          usage: {},
          modelUsage: { 'grok-4.6-build': {} }
        }
      ])
    ).toEqual({ markdown: 'Answer.' })
  })

  it('keeps the Claude result line after dropping partial messages', () => {
    expect(
      reparse('claude', [
        { type: 'stream_event', event: { type: 'content_block_delta' } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: long }] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 's',
          result: long,
          usage: {},
          modelUsage: { 'claude-opus-5': {} }
        }
      ])
    ).toEqual({ markdown: long })
  })
})
