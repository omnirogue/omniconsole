import { describe, expect, it, vi } from 'vitest'
import { workflowCallActivity, workflowToolStep } from './workflow-call-activity'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))

/**
 * Why these tests exist: Details used to dump the raw per-token NDJSON a provider streams. The
 * readable view keeps the steps a person cares about and drops the token and bookkeeping events.
 * Line shapes follow main's live-stream parser (workflow-live-stream.ts), measured by probes.
 */
const ndjson = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n')

describe('workflowCallActivity', () => {
  it('reads Claude tool calls and messages and drops per-token stream events', () => {
    const stdout = ndjson(
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Th' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'e' } } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Check the retry path first.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/reserve.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'store.save' } }
          ]
        }
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'file text' }] } },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Edit' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The loop is off by one.' }] }
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'The loop is off by one.' }
    )
    expect(workflowCallActivity('claude', stdout)).toEqual([
      { step: 1, kind: 'thinking', text: 'Check the retry path first.' },
      { step: 2, kind: 'tool', text: 'Read src/reserve.ts' },
      { step: 3, kind: 'tool', text: 'Searched for store.save' },
      { step: 4, kind: 'problem', text: 'Not allowed to use Edit (read-only)' },
      { step: 5, kind: 'message', text: 'The loop is off by one.' }
    ])
  })

  it('reads Codex commands, reasoning, messages and a failed turn', () => {
    const stdout = ndjson(
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { type: 'command_execution', command: '/bin/zsh -lc "rg save src"' }
      },
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg save src' } },
      { type: 'item.completed', item: { type: 'reasoning', text: 'save is not awaited' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Found it.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
      { type: 'turn.failed', error: { message: 'stream disconnected' } }
    )
    expect(workflowCallActivity('codex', stdout).map(({ kind, text }) => [kind, text])).toEqual([
      ['tool', 'Ran rg save src'],
      ['thinking', 'save is not awaited'],
      ['message', 'Found it.'],
      ['problem', 'stream disconnected']
    ])
  })

  it('joins Grok and Gemini streamed chunks into one message per turn', () => {
    const grok = ndjson(
      { type: 'thought', data: 'Look at ' },
      { type: 'thought', data: 'notify.ts' },
      { type: 'tool_call', toolName: 'read_file', rawInput: { path: 'src/notify.ts' } },
      { type: 'text', data: 'Webhook ' },
      { type: 'text', data: 'retries forever.' },
      { type: 'usage', usage: { input_tokens: 3, output_tokens: 1 } }
    )
    expect(workflowCallActivity('grok', grok).map(({ kind, text }) => [kind, text])).toEqual([
      ['thinking', 'Look at notify.ts'],
      ['tool', 'Read src/notify.ts'],
      ['message', 'Webhook retries forever.']
    ])
    const gemini = ndjson(
      { type: 'init', session_id: 'g' },
      { type: 'message', role: 'user', content: 'Find bugs' },
      { type: 'message', role: 'assistant', content: 'Two ', delta: true },
      { type: 'message', role: 'assistant', content: 'bugs.', delta: true },
      { type: 'tool_use', tool_name: 'list_directory', parameters: { dir_path: 'src' } },
      { type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } }
    )
    expect(workflowCallActivity('gemini', gemini).map(({ kind, text }) => [kind, text])).toEqual([
      ['message', 'Two bugs.'],
      ['tool', 'Listed src']
    ])
  })

  it('yields nothing for plain text or an unknown provider, so the raw capture shows', () => {
    expect(workflowCallActivity('claude', 'First line\nUnicode café')).toEqual([])
    expect(workflowCallActivity(undefined, ndjson({ type: 'assistant' }))).toEqual([])
    // A torn final line is skipped, not fatal.
    const torn = `${ndjson({ type: 'item.completed', item: { type: 'agent_message', text: 'Ok' } })}\n{"type":"item.`
    expect(workflowCallActivity('codex', torn)).toEqual([{ step: 1, kind: 'message', text: 'Ok' }])
  })
})

describe('workflowToolStep', () => {
  it('names common read-only tools and falls back to the tool name', () => {
    expect(workflowToolStep('Glob', { pattern: '**/*.ts' })).toBe(
      'Looked for files matching **/*.ts'
    )
    expect(workflowToolStep('Bash', { command: 'git log -1' })).toBe('Ran git log -1')
    expect(workflowToolStep('WebFetch', {})).toBe('Used WebFetch')
    expect(workflowToolStep('Read', { file_path: `src/${'a'.repeat(300)}.ts` }).length).toBe(160)
  })
})
