import { describe, expect, it } from 'vitest'
import {
  createWorkflowLiveStream,
  workflowShellCommand,
  workflowToolActivity
} from './workflow-live-stream'
import type { WorkflowLiveUpdate } from './workflow-live-observer'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'

function feed(route: LocalWorkflowRoute, values: unknown[], root?: string): WorkflowLiveUpdate[] {
  const updates: WorkflowLiveUpdate[] = []
  const line = createWorkflowLiveStream(route, (update) => updates.push(update), { root })
  for (const value of values) {
    line(typeof value === 'string' ? value : JSON.stringify(value))
  }
  return updates
}
const texts = (updates: WorkflowLiveUpdate[]) => updates.flatMap((update) => update.text ?? [])
/** The rolling tail the registry builds from the text updates. */
const tail = (updates: WorkflowLiveUpdate[]) => texts(updates).join('')
// Consecutive repeats collapse: an update may restate the activity while it adds text.
const activities = (updates: WorkflowLiveUpdate[]) =>
  updates
    .flatMap((update) => update.activity ?? [])
    .filter((activity, index, all) => activity !== all[index - 1])

describe('Claude live stream', () => {
  // Trimmed from the 2026-09-21 probe of claude 2.1.278 (stream-json, partial messages).
  const event = (value: unknown) => ({ type: 'stream_event', event: value })
  const lines = [
    { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'] },
    event({
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } }
    }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Look' } }),
    event({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', name: 'Read' }
    }),
    event({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"f' }
    }),
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/app.ts' } }]
      }
    },
    event({ type: 'message_delta', usage: { output_tokens: 20 } }),
    event({ type: 'message_stop' }),
    { type: 'user', message: { content: [{ type: 'tool_result', content: '1\tx' }] } },
    event({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'StructuredOutput' }
    }),
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"answer":' }
    }),
    { type: 'system', subtype: 'permission_denied', tool_name: 'Write' }
  ]

  it('reports thinking, reads relative to the workspace, answer text and running tokens', () => {
    const updates = feed('claude', lines, '/repo')
    expect(activities(updates)).toEqual([
      'Thinking…',
      'Writing the answer',
      'Reading src/app.ts',
      'Thinking…',
      'Writing the answer',
      'Refused Write (read-only)'
    ])
    // Text deltas and the StructuredOutput JSON stream through, each block set apart from the
    // text before it; other tool input does not.
    expect(texts(updates)).toEqual(['Look', '\n\n{"answer":'])
    expect(updates.flatMap((update) => update.tokens ?? []).at(-1)).toEqual({
      input: 105,
      output: 20
    })
  })

  it('separates text blocks and messages without breaking up one block or doubling breaks', () => {
    const block = (index: number, type: string) =>
      event({ type: 'content_block_start', index, content_block: { type } })
    const delta = (index: number, value: string) =>
      event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } })
    const updates = feed('claude', [
      event({ type: 'message_start', message: { usage: {} } }),
      block(0, 'text'),
      delta(0, "I'll start by surveying the workspace to understand "),
      delta(0, 'what this service is.'),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } }),
      event({ type: 'message_stop' }),
      event({ type: 'message_start', message: { usage: {} } }),
      block(0, 'thinking'),
      block(1, 'text'),
      block(2, 'text'),
      delta(2, "Small service — I'll read all the source files at once.\n"),
      block(3, 'text'),
      delta(3, 'Reading them now.')
    ])
    // The acceptance run showed "…what this service is.Small service…".
    expect(tail(updates)).toBe(
      "I'll start by surveying the workspace to understand what this service is.\n\nSmall service — I'll read all the source files at once.\n\nReading them now."
    )
  })

  it('tops up the line breaks already at a join to one blank line and adds none past it', () => {
    const block = (index: number, value: string) => [
      event({ type: 'content_block_start', index, content_block: { type: 'text' } }),
      event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } })
    ]
    const updates = feed('claude', [
      ...block(0, 'One.'),
      ...block(1, '\nTwo.\n'),
      ...block(2, 'Three.\n\n'),
      ...block(3, 'Four.'),
      ...block(4, '\n\n\nFive.')
    ])
    expect(texts(updates)).toEqual(['One.', '\n\nTwo.\n', '\nThree.\n\n', 'Four.', '\n\n\nFive.'])
    expect(tail(updates)).toBe('One.\n\nTwo.\n\nThree.\n\nFour.\n\n\nFive.')
  })
})

describe('Codex live stream', () => {
  // Trimmed from the 2026-09-21 probe of codex-cli 0.155.1 (exec --json).
  it('reports commands without the shell wrapper, reasoning, messages and usage', () => {
    const updates = feed('codex', [
      { type: 'thread.started', thread_id: 'x' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { type: 'command_execution', command: '/bin/zsh -lc "sed -n \'1,40p\' src/a.ts"' }
      },
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x' } },
      { type: 'item.completed', item: { type: 'reasoning', text: '**Reviewing**' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"done"}' } },
      { type: 'turn.completed', usage: { input_tokens: 19576, output_tokens: 755 } }
    ])
    expect(activities(updates)).toEqual([
      'Thinking…',
      "Running sed -n '1,40p' src/a.ts",
      'Thinking…',
      'Writing the answer'
    ])
    // Each completed item is its own message: set apart from the one before, nothing trailing.
    expect(texts(updates)).toEqual(['**Reviewing**', '\n\n{"summary":"done"}'])
    expect(updates.at(-1)).toEqual({ tokens: { input: 19576, output: 755 } })
  })
})

describe('Grok live stream', () => {
  // Trimmed from the 2026-09-21 probe of grok 1.0.34 (--output-format streaming-json).
  it('reports thoughts, tool calls, answer text and tokens', () => {
    const updates = feed(
      'grok',
      [
        { type: 'available_commands', tools: ['read_file'] },
        { type: 'thought', data: 'The' },
        { type: 'thought', data: ' user' },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } },
        { type: 'tool_call', toolName: 'list_dir', rawInput: { target_directory: 'src' } },
        { type: 'tool_call_update', toolCallId: 'c', status: 'completed' },
        { type: 'text', data: '{"' },
        { type: 'usage', usage: { input_tokens: 200, output_tokens: 20 } },
        { type: 'end', usage: { input_tokens: 300, output_tokens: 30 } }
      ],
      '/repo'
    )
    expect(activities(updates)).toEqual([
      'Thinking…',
      'Listing src',
      'Thinking…',
      'Writing the answer'
    ])
    expect(texts(updates)).toEqual(['{"'])
    expect(updates.flatMap((update) => update.tokens ?? [])).toEqual([
      { input: 100, output: 10 },
      { input: 300, output: 30 },
      { input: 300, output: 30 }
    ])
  })

  it('sets a new model response apart from the text before it, never a single delta', () => {
    const updates = feed('grok', [
      { type: 'text', data: "I'll read the file " },
      { type: 'text', data: 'first.' },
      { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'tool_call', toolName: 'read_file', rawInput: { target_file: 'a' } },
      { type: 'tool_call_update', toolCallId: 'c', status: 'completed' },
      { type: 'text', data: 'The file exports ' },
      { type: 'text', data: '**reserve**.' }
    ])
    expect(texts(updates)).toEqual([
      "I'll read the file ",
      'first.',
      '\n\nThe file exports ',
      '**reserve**.'
    ])
  })
})

describe('Gemini live stream', () => {
  // Trimmed from the 2026-09-21 probe of gemini 0.59.0 (--output-format stream-json).
  it('skips the echoed prompt and reports tools, deltas and tokens', () => {
    const updates = feed('gemini', [
      { type: 'init', session_id: 's', model: 'gemini-3.8-flash' },
      { type: 'message', role: 'user', content: 'the whole prompt' },
      { type: 'tool_use', tool_name: 'grep_search', parameters: { pattern: 'reserve(' } },
      { type: 'tool_result', tool_id: 't', status: 'success' },
      { type: 'message', role: 'assistant', content: 'It ', delta: true },
      { type: 'message', role: 'assistant', content: 'works.', delta: true },
      { type: 'result', status: 'success', stats: { input_tokens: 50, output_tokens: 5 } }
    ])
    expect(activities(updates)).toEqual([
      'Thinking…',
      'Searching for reserve(',
      'Thinking…',
      'Writing the answer'
    ])
    expect(texts(updates)).toEqual(['It ', 'works.'])
    expect(updates.at(-1)).toEqual({ tokens: { input: 50, output: 5 } })
  })

  it('sets a message after a tool, or a whole message, apart; deltas of one message join', () => {
    const delta = (content: string) => ({
      type: 'message',
      role: 'assistant',
      content,
      delta: true
    })
    const updates = feed('gemini', [
      { type: 'init', session_id: 's' },
      { type: 'message', role: 'user', content: 'the whole prompt' },
      delta('Let me '),
      delta('look.'),
      { type: 'tool_use', tool_name: 'read_file', parameters: { file_path: 'a' } },
      { type: 'tool_result', tool_id: 't', status: 'success' },
      delta('It '),
      delta('works.'),
      { type: 'message', role: 'assistant', content: 'Done.' }
    ])
    expect(tail(updates)).toBe('Let me look.\n\nIt works.\n\nDone.')
  })
})

describe('live stream robustness', () => {
  it('ignores legacy pretty-printed envelopes and malformed lines', () => {
    expect(feed('grok', ['{', '  "stopReason": "end_turn",', '}', '{"type":', 'plain'])).toEqual([])
  })

  it('names tools and shell commands for people', () => {
    expect(workflowToolActivity('Glob', { pattern: '**/*.ts' })).toBe('Finding **/*.ts')
    expect(workflowToolActivity('read_file', { file_path: '/elsewhere/x.ts' }, '/repo')).toBe(
      'Reading /elsewhere/x.ts'
    )
    expect(workflowToolActivity('custom', undefined)).toBe('Using custom')
    expect(workflowShellCommand("/bin/bash -c 'ls src'")).toBe('ls src')
    expect(workflowShellCommand('rg -n foo')).toBe('rg -n foo')
    expect(
      workflowToolActivity('read', { file_path: `/repo/${'a'.repeat(200)}` }, '/repo')
    ).toHaveLength(120)
  })
})
