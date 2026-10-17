import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../../shared/native-chat-types'
import { readCapturedAssistantSummary } from './conversation-fleet-context-summary'

const message = (
  id: string,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage => ({ id, role, blocks, source: 'transcript', timestamp: 1 })

const text = (body: string): NativeChatTextBlock => ({ type: 'text', text: body })
const providerFrame = (): NativeChatTextBlock => ({
  ...text('Provider status: session completed'),
  providerFrame: {
    provider: 'codex',
    kind: 'session.completed',
    payload: { head: '{"status":"completed"}', byteLength: 22, digest: 'frame', truncated: false }
  }
})

describe('captured assistant summary', () => {
  it('retains the complete last assistant response beyond preview-sized limits', () => {
    const response = `START\n${'Detailed implementation and verification evidence.\n'.repeat(5000)}END`
    const messages = [
      message('earlier', [text('Earlier response')]),
      message('latest', [text(response)])
    ]

    expect(readCapturedAssistantSummary(messages)).toBe(response)
  })

  it('preserves substantive text block order while omitting tool and image blocks', () => {
    const messages = [
      message('latest', [
        text('First finding'),
        { type: 'tool-call', name: 'exec', input: { command: 'pnpm test' } },
        { type: 'tool-result', output: 'Tests passed' },
        text('Second finding'),
        { type: 'image-ref', path: '/owner/result.png', alt: 'Screenshot' },
        text('Next action')
      ])
    ]

    expect(readCapturedAssistantSummary(messages)).toBe(
      'First finding\nSecond finding\nNext action'
    )
  })

  it('ignores later tools, reasoning, system messages, user turns, and blank assistant turns', () => {
    const messages = [
      message('answer', [text('The substantive assistant response')]),
      message('tool-call', [{ type: 'tool-call', name: 'exec', input: 'git status' }]),
      message('tool-result', [text('Tool output that is not assistant prose')], 'tool'),
      message('reasoning', [text('Private reasoning')], 'reasoning'),
      message('system', [text('The session is complete')], 'system'),
      message('user', [text('Follow up with a review')], 'user'),
      message('blank', [text(' \n\t ')])
    ]

    expect(readCapturedAssistantSummary(messages)).toBe('The substantive assistant response')
  })

  it('excludes provider frames both within an answer and in later assistant records', () => {
    const messages = [
      message('answer', [providerFrame(), text('Actual assistant prose'), providerFrame()]),
      message('provider-only', [providerFrame()])
    ]

    expect(readCapturedAssistantSummary(messages)).toBe('Actual assistant prose')
  })

  it('preserves whitespace and blank blocks within a substantive assistant response', () => {
    const messages = [
      message('answer', [text('  Leading spaces\n'), text(' \t\n'), text('\tTrailing spaces  ')])
    ]

    expect(readCapturedAssistantSummary(messages)).toBe(
      '  Leading spaces\n\n \t\n\n\tTrailing spaces  '
    )
  })

  it('returns no summary when raw records have no projected messages', () => {
    expect(readCapturedAssistantSummary([])).toBeUndefined()
  })

  it('does not substitute user text, reasoning, or provider metadata when no answer exists', () => {
    const messages = [
      message('request', [text('Please implement this workflow')], 'user'),
      message('reasoning', [text('Unfinished analysis')], 'reasoning'),
      message('system', [text('Conversation status')], 'system'),
      message('provider-only', [providerFrame()]),
      message('tool-only', [{ type: 'tool-result', output: 'Completed' }]),
      message('blank', [text('\n  ')])
    ]

    expect(readCapturedAssistantSummary(messages)).toBeUndefined()
  })
})
