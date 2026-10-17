import { describe, expect, it } from 'vitest'
import {
  decodeOmpTurnLifecycle,
  nativeChatTurnLifecycleDecoderForAgent
} from './transcript-turn-lifecycle'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

function record(role: string, stopReason?: string, content: unknown[] = []) {
  return JSON.stringify({
    type: 'message',
    id: 'native-record',
    timestamp: '2026-09-18T00:56:15.905Z',
    message: { role, stopReason, content }
  })
}

describe('OMP provider turn boundaries', () => {
  it('exposes an OMP lifecycle decoder and leaves unrelated formats unchanged', () => {
    expect(nativeChatTurnLifecycleDecoderForAgent('omp')).toBe(decodeOmpTurnLifecycle)
    expect(nativeChatTurnLifecycleDecoderForAgent('grok')).toBeNull()
    expect(nativeChatTurnLifecycleDecoderForAgent('pi')).toBeNull()
  })

  it.each([{ content: [] }, { content: [{ type: 'text', text: 'Partial answer' }] }])(
    'preserves an explicit aborted boundary independently of streamed content %j',
    ({ content }) => {
      const line = record('assistant', 'aborted', content)
      expect(decodeOmpTurnLifecycle(line, 'fallback')).toEqual({
        state: 'interrupted',
        turnId: 'native-record',
        timestamp: Date.parse('2026-09-18T00:56:15.905Z')
      })
      if (content.length > 0) {
        expect(decodeOmpTranscriptLine(line, 'fallback')?.blocks).toEqual(content)
      }
    }
  )

  it.each(['stop', 'length', 'error'])(
    'treats the native terminal reason %s as a completed generation',
    (reason) => {
      expect(decodeOmpTurnLifecycle(record('assistant', reason), 'fallback')?.state).toBe(
        'completed'
      )
    }
  )

  it('records the new user generation but does not settle on tools or final-looking prose', () => {
    expect(
      decodeOmpTurnLifecycle(
        record('user', undefined, [{ type: 'text', text: 'do work' }]),
        'fallback'
      )?.state
    ).toBe('working')
    expect(decodeOmpTurnLifecycle(record('assistant', 'toolUse'), 'fallback')).toBeNull()
    expect(decodeOmpTurnLifecycle(record('toolResult'), 'fallback')).toBeNull()
    expect(
      decodeOmpTurnLifecycle(
        record('assistant', undefined, [{ type: 'text', text: 'Done' }]),
        'fallback'
      )
    ).toBeNull()
    expect(
      decodeOmpTurnLifecycle(JSON.stringify({ type: 'model_change', id: 'model' }), 'fallback')
    ).toBeNull()
  })
})
