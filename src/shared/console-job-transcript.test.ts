import { describe, expect, it } from 'vitest'
import { assembleJobEvidenceRecords, jobEvidenceTranscript } from './console-job-transcript'
import type { ConsoleJobEvidenceEntry } from './console-job-evidence'

const entry = (
  id: number,
  kind: ConsoleJobEvidenceEntry['kind'],
  text: string
): ConsoleJobEvidenceEntry => ({ id, kind, text, at: '2026-09-12T12:00:00Z' })

describe('captured job transcript', () => {
  it('keeps a captured multiline prompt in one user turn', () => {
    const transcript = jobEvidenceTranscript([
      entry(1, 'input', 'Review this request.\n'),
      entry(2, 'input', 'Context from the source session.\n')
    ])
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].blocks[0]).toEqual({
      type: 'text',
      text: 'Review this request.\nContext from the source session.\n'
    })
  })

  it('preserves actual input, Claude tool calls and results without copying filtered output twice', () => {
    const transcript = jobEvidenceTranscript([
      entry(1, 'input', 'Review the current checkout.'),
      entry(
        2,
        'provider_event',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Checking the files.' },
              { type: 'tool_use', name: 'Read', input: { path: 'app.ts' } }
            ]
          }
        })
      ),
      entry(
        3,
        'provider_event',
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'export const passed = true' }] }
        })
      ),
      entry(4, 'output', 'Checking the files.\n')
    ])
    expect(transcript.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool'
    ])
    expect(transcript.messages[1].blocks[1]).toEqual({
      type: 'tool-call',
      name: 'Read',
      input: { path: 'app.ts' }
    })
    expect(transcript.messages[2].blocks[0]).toMatchObject({
      type: 'tool-result',
      output: 'export const passed = true'
    })
  })

  it('renders Codex command results and messages from the real provider stream', () => {
    const transcript = jobEvidenceTranscript([
      entry(1, 'provider_event', JSON.stringify({ type: 'thread.started', thread_id: 'thread_1' })),
      entry(
        2,
        'provider_event',
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: 'One test failed',
            exit_code: 1
          }
        })
      ),
      entry(
        3,
        'provider_event',
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'The failing case is fixed.'
          }
        })
      )
    ])
    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[0].blocks[1]).toEqual({
      type: 'tool-result',
      output: 'One test failed',
      isError: true
    })
    expect(transcript.messages[1].blocks[0]).toEqual({
      type: 'text',
      text: 'The failing case is fixed.'
    })
  })

  it('reassembles oversized records across pages and refuses missing or mixed parts', () => {
    const first = { ...entry(1, 'input', 'Original '), record_id: 1, part: 0, final: false }
    const last = { ...entry(2, 'input', 'request'), record_id: 1, part: 1, final: true }
    expect(jobEvidenceTranscript([first])).toEqual({ messages: [], pending: 1 })
    expect(jobEvidenceTranscript([first, last]).messages[0].blocks[0]).toEqual({
      type: 'text',
      text: 'Original request'
    })
    expect(assembleJobEvidenceRecords([last]).pending).toBe(1)
    expect(assembleJobEvidenceRecords([first, { ...last, kind: 'provider_event' }]).pending).toBe(1)
  })
})
