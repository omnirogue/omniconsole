import { describe, expect, it } from 'vitest'
import {
  parseWorkflowNativeResult,
  WorkflowCallStalledError,
  workflowUsageTokens
} from './workflow-native-result'
import type { ProcessResult } from '../../../shared/child-process/process-spec'

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false
}
const events = [
  { type: 'thread.started', thread_id: 'thread-fixture' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"probe"}' } },
  { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }
]
const receipt = (
  stdout = events.map((event) => JSON.stringify(event)).join('\n')
): ProcessResult => ({ code: 0, signal: null, timedOut: false, stdout, stderr: '' })
const parse = (r: ProcessResult) => parseWorkflowNativeResult('codex', r, schema, () => null)

describe('native workflow result acceptance', () => {
  it('extracts a complete native Codex turn with attributable usage', () => {
    expect(parse(receipt())).toEqual({
      value: { answer: 'probe' },
      providerSessionId: 'thread-fixture',
      usage: { input_tokens: 12, output_tokens: 4 }
    })
  })
  it('decodes Codex strict-schema null placeholders before original host validation', () => {
    const optionalSchema = {
      type: 'object',
      properties: {
        novelty: {
          type: 'object',
          properties: {
            contradictsFindingId: { type: 'string' },
            explicitlyNullable: { enum: ['known', null] }
          },
          required: ['explicitlyNullable'],
          additionalProperties: false
        }
      },
      required: ['novelty'],
      additionalProperties: false
    }
    const outputEvents = structuredClone(events)
    outputEvents[2].item!.text =
      '{"novelty":{"contradictsFindingId":null,"explicitlyNullable":null}}'

    expect(
      parseWorkflowNativeResult(
        'codex',
        receipt(outputEvents.map((event) => JSON.stringify(event)).join('\n')),
        optionalSchema,
        () => null
      ).value
    ).toEqual({ novelty: { explicitlyNullable: null } })
  })
  it.each([
    { code: 1 },
    { timedOut: true },
    { stdoutTruncated: true },
    { stderrTruncated: true }
  ] as const)('rejects incomplete capture/process %j', (patch) => {
    expect(() => parse({ ...receipt(), ...patch })).toThrow()
  })
  it('says how long a timed-out call was given, and keeps other process failures generic', () => {
    const killed: ProcessResult = { ...receipt(), code: null, signal: 'SIGTERM', timedOut: true }
    const timeout = (timeoutMs?: number) => () =>
      parseWorkflowNativeResult('codex', killed, schema, () => null, 'text', timeoutMs)
    expect(timeout(15 * 60_000)).toThrow(/^timed out after 15:00$/)
    expect(timeout(60 * 60_000)).toThrow(/^timed out after 1:00:00$/)
    expect(timeout(45_000)).toThrow(/^timed out after 45s$/)
    // The time the process ran under: rounded to whole milliseconds and capped at an hour.
    expect(timeout(59_999.6)).toThrow(/^timed out after 1:00$/)
    expect(timeout(2 * 60 * 60_000)).toThrow(/^timed out after 1:00:00$/)
    expect(timeout(0.5)).toThrow(/^timed out$/)
    // Without its own timeout the call ran under the launch mode's default, which is not known here.
    expect(timeout()).toThrow(/^timed out$/)
    expect(() => parse({ ...killed, stdoutTruncated: true })).toThrow('workflow output overflow')
    for (const patch of [{ code: 1 }, { code: null, signal: 'SIGKILL' as const }]) {
      expect(() => parse({ ...receipt(), ...patch })).toThrow(
        /^workflow process did not complete successfully \((exit 1|signal SIGKILL)\)/
      )
    }
  })
  it('says a stalled call was ended for its silence, before any other process failure', () => {
    const ended: ProcessResult = { ...receipt(), code: null, signal: 'SIGTERM' }
    const stalled = { ...ended, stdoutTruncated: true as const, stalledAfterMs: 10 * 60_000 }
    expect(() => parse(stalled)).toThrow(WorkflowCallStalledError)
    expect(() => parse(stalled)).toThrow(/^stalled: no output for 10:00, so it was ended$/)
    expect(() => parse(ended)).not.toThrow(WorkflowCallStalledError)
  })
  it('names why a process failed from the last line it wrote to stderr', () => {
    expect(() =>
      parse({
        ...receipt(),
        code: 1,
        stderr:
          "warning: sandbox could not be applied\nerror: could not apply the 'omni-workflow' sandbox profile\n"
      })
    ).toThrow(
      "workflow process did not complete successfully (exit 1): error: could not apply the 'omni-workflow' sandbox profile"
    )
  })
  it('rejects duplicate final messages and a late error', () => {
    expect(() =>
      parse(
        receipt([...events, events[2], events[3]].map((event) => JSON.stringify(event)).join('\n'))
      )
    ).toThrow()
    expect(() => parse(receipt(`${receipt().stdout}\n{"type":"error"}`))).toThrow()
  })
  it('rejects semantically invalid output after schema validation', () => {
    expect(() =>
      parseWorkflowNativeResult('codex', receipt(), schema, () => 'unknown ballot label')
    ).toThrow('unknown ballot label')
  })
  it('rejects the observed Claude error envelope even with subtype success', () => {
    expect(() =>
      parseWorkflowNativeResult(
        'claude',
        receipt(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'Failed to authenticate: OAuth session expired and could not be refreshed'
          })
        ),
        schema,
        () => null
      )
    ).toThrow('successful result')
  })
  it('rejects multiple JSON values inside the final answer', () => {
    const invalid = structuredClone(events)
    invalid[2].item!.text = '{} {}'
    expect(() => parse(receipt(invalid.map((event) => JSON.stringify(event)).join('\n')))).toThrow()
  })
})

describe('Grok native schema envelope', () => {
  const grok = {
    stopReason: 'end_turn',
    sessionId: 'session-fixture',
    requestId: 'request-fixture',
    structuredOutput: { answer: 'probe' },
    usage: { input_tokens: 12 },
    modelUsage: { 'grok-4.6-build': { modelCalls: 1 } }
  }
  it('preserves provider request and resolved model attribution', () => {
    const result = parseWorkflowNativeResult(
      'grok',
      receipt(JSON.stringify(grok)),
      schema,
      () => null
    )
    expect(result.resolvedModels).toEqual(['grok-4.6-build'])
    expect(result.providerRequestId).toBe('request-fixture')
    expect(result.value).toEqual({ answer: 'probe' })
  })
  it('rejects an interrupted or output-limited response', () => {
    expect(() =>
      parseWorkflowNativeResult(
        'grok',
        receipt(JSON.stringify({ ...grok, stopReason: 'max_tokens' })),
        schema,
        () => null
      )
    ).toThrow('finish the turn')
  })
})

const lines = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n')
const markdownSchema = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown'],
  additionalProperties: false
}

describe('streamed Claude output', () => {
  // Trimmed from the 2026-09-21 probes (claude 2.1.278, stream-json with partial messages).
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'tool_use',
    session_id: 'attempt-fixture',
    result: '{"answer":"probe"}',
    structured_output: { answer: 'probe' },
    usage: { input_tokens: 12, output_tokens: 4 },
    modelUsage: { 'claude-opus-5': { costUSD: 0.01 } }
  }
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'attempt-fixture', model: 'claude-opus-5' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '1\timport x' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }
  ]

  it('takes the last result line without requiring end_turn', () => {
    const parsed = parseWorkflowNativeResult(
      'claude',
      receipt(lines([...stream, result])),
      schema,
      () => null
    )
    expect(parsed).toEqual({
      value: { answer: 'probe' },
      providerSessionId: 'attempt-fixture',
      resolvedModels: ['claude-opus-5'],
      usage: { input_tokens: 12, output_tokens: 4 }
    })
  })

  it('still parses the legacy single envelope', () => {
    expect(
      parseWorkflowNativeResult('claude', receipt(JSON.stringify(result)), schema, () => null).value
    ).toEqual({ answer: 'probe' })
  })

  it('wraps a text answer from the result field as markdown', () => {
    const text = {
      ...result,
      stop_reason: 'end_turn',
      result: '## Answer\n\nok\n',
      structured_output: undefined
    }
    const parsed = parseWorkflowNativeResult(
      'claude',
      receipt(lines([...stream, text])),
      markdownSchema,
      () => null,
      'text'
    )
    expect(parsed.value).toEqual({ markdown: '## Answer\n\nok' })
  })

  it('refuses an empty text answer and a stream without a result line', () => {
    const empty = { ...result, result: '   ' }
    expect(() =>
      parseWorkflowNativeResult(
        'claude',
        receipt(lines([empty])),
        markdownSchema,
        () => null,
        'text'
      )
    ).toThrow('empty')
    expect(() =>
      parseWorkflowNativeResult('claude', receipt(lines(stream)), schema, () => null)
    ).toThrow('successful result')
  })
})

describe('Codex progress notes', () => {
  const note = {
    type: 'item.completed',
    item: { type: 'agent_message', text: '{"answer":"note"}' }
  }
  const command = {
    type: 'item.completed',
    item: { type: 'command_execution', command: "/bin/zsh -lc 'rg x'", aggregated_output: 'x' }
  }
  const final = {
    type: 'item.completed',
    item: { type: 'agent_message', text: '{"answer":"final"}' }
  }

  it('answers with the message that directly precedes turn.completed', () => {
    const stdout = lines([events[0], events[1], note, command, final, events[3]])
    expect(parse(receipt(stdout)).value).toEqual({ answer: 'final' })
  })

  it('refuses a turn whose last event before completion is not the answer', () => {
    const stdout = lines([events[0], events[1], final, command, events[3]])
    expect(() => parse(receipt(stdout))).toThrow('final message')
  })

  it('wraps the final message as markdown in text mode', () => {
    const text = {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Plain **answer**' }
    }
    const stdout = lines([events[0], events[1], note, text, events[3]])
    expect(
      parseWorkflowNativeResult('codex', receipt(stdout), markdownSchema, () => null, 'text').value
    ).toEqual({ markdown: 'Plain **answer**' })
  })
})

describe('Grok streaming-json output', () => {
  // Trimmed from the 2026-09-21 probes (grok 1.0.34, --output-format streaming-json).
  const end = {
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 'session-fixture',
    requestId: 'request-fixture',
    usage: { input_tokens: 6675, output_tokens: 82 },
    modelUsage: { 'grok-4.6-build': { modelCalls: 2 } }
  }
  const stream = [
    { type: 'available_commands', tools: ['read_file', 'grep', 'list_dir'] },
    { type: 'text', data: "I'll read the file first." },
    { type: 'usage', usage: { input_tokens: 6675, output_tokens: 82 } },
    {
      type: 'tool_call',
      toolCallId: 'call-0',
      toolName: 'read_file',
      rawInput: { target_file: 'a' }
    },
    { type: 'tool_call_update', toolCallId: 'call-0', status: 'completed', content: [] },
    { type: 'text', data: 'The file exports ' },
    { type: 'text', data: '**reserve**.' }
  ]

  it('takes the schema answer from the end line', () => {
    const parsed = parseWorkflowNativeResult(
      'grok',
      receipt(lines([...stream, { ...end, structuredOutput: { answer: 'probe' } }])),
      schema,
      () => null
    )
    expect(parsed).toMatchObject({
      value: { answer: 'probe' },
      providerSessionId: 'session-fixture',
      providerRequestId: 'request-fixture',
      resolvedModels: ['grok-4.6-build']
    })
  })

  it('answers in text with what was written after the last tool call', () => {
    const parsed = parseWorkflowNativeResult(
      'grok',
      receipt(lines([...stream, end])),
      markdownSchema,
      () => null,
      'text'
    )
    expect(parsed.value).toEqual({ markdown: 'The file exports **reserve**.' })
  })

  it('refuses an error line, a missing end line and an unfinished turn', () => {
    const parseGrok = (values: unknown[]) =>
      parseWorkflowNativeResult('grok', receipt(lines(values)), markdownSchema, () => null, 'text')
    expect(() => parseGrok([...stream, { type: 'error', message: 'x' }, end])).toThrow()
    expect(() => parseGrok(stream)).toThrow('finish the turn')
    expect(() => parseGrok([...stream, { ...end, stopReason: 'max_turn_requests' }])).toThrow(
      'finish the turn'
    )
  })
})

describe('Gemini stream-json output', () => {
  // Trimmed from the 2026-09-21 probes (gemini 0.59.0, --output-format stream-json).
  const init = { type: 'init', session_id: 'attempt-fixture', model: 'gemini-3.8-flash' }
  const user = { type: 'message', role: 'user', content: 'Question\n\nComplete the task above.' }
  const stats = {
    total_tokens: 18908,
    input_tokens: 16953,
    output_tokens: 185,
    models: { 'gemini-3.8-flash': { total_tokens: 18908 } }
  }
  const tools = [
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'a' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: '' }
  ]
  const delta = (content: string) => ({ type: 'message', role: 'assistant', content, delta: true })
  const done = { type: 'result', status: 'success', stats }

  it('joins the assistant deltas after the last tool event as the schema answer', () => {
    const parsed = parseWorkflowNativeResult(
      'gemini',
      receipt(
        lines([
          init,
          user,
          delta('Let me look.'),
          ...tools,
          delta('{"answer":'),
          delta('"probe"}\n '),
          done
        ])
      ),
      schema,
      () => null
    )
    expect(parsed).toEqual({
      value: { answer: 'probe' },
      providerSessionId: 'attempt-fixture',
      resolvedModels: ['gemini-3.8-flash'],
      usage: { ...stats, thoughts_tokens: 1770 }
    })
  })

  it('answers in text', () => {
    const parsed = parseWorkflowNativeResult(
      'gemini',
      receipt(lines([init, user, ...tools, delta('It exports '), delta('`reserve`. '), done])),
      markdownSchema,
      () => null,
      'text'
    )
    expect(parsed.value).toEqual({ markdown: 'It exports `reserve`.' })
  })

  it('refuses an error result even with exit 0, and a missing init', () => {
    const failed = { ...done, status: 'error', error: { type: 'unknown', message: 'blocked' } }
    expect(() =>
      parseWorkflowNativeResult('gemini', receipt(lines([init, user, failed])), schema, () => null)
    ).toThrow('successful result')
    expect(() =>
      parseWorkflowNativeResult(
        'gemini',
        receipt(lines([user, delta('{"answer":"x"}'), done])),
        schema,
        () => null
      )
    ).toThrow('successful result')
  })

  it('tolerates warnings but not errors', () => {
    const warning = { type: 'error', severity: 'warning', message: 'slow' }
    const error = { type: 'error', severity: 'error', message: 'broken' }
    const stdout = (extra: unknown) => lines([init, user, extra, delta('{"answer":"x"}'), done])
    expect(
      parseWorkflowNativeResult('gemini', receipt(stdout(warning)), schema, () => null).value
    ).toEqual({
      answer: 'x'
    })
    expect(() =>
      parseWorkflowNativeResult('gemini', receipt(stdout(error)), schema, () => null)
    ).toThrow()
  })
})

describe('receipt token usage', () => {
  it('normalises every route to input and output tokens', () => {
    // Claude and Grok report cache traffic beside input_tokens.
    expect(
      workflowUsageTokens({
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 85,
        output_tokens: 7
      })
    ).toEqual({ input: 100, output: 7 })
    // Codex counts cached input inside input_tokens.
    expect(
      workflowUsageTokens({ input_tokens: 19576, cached_input_tokens: 12288, output_tokens: 755 })
    ).toEqual({ input: 19576, output: 755 })
    expect(workflowUsageTokens({ total_tokens: 3 })).toBeUndefined()
    expect(workflowUsageTokens(null)).toBeUndefined()
  })
})
