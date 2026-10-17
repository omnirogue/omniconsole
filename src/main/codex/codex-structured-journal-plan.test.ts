import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

function setup() {
  const sink = {
    appendItem: vi.fn(),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  } satisfies StructuredAgentSessionEventSink
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => 'parent-thread'
  })
  return { sink, translator }
}

describe('Codex plan event routing', () => {
  it('preserves a child plan as diagnostic history without replacing the parent checklist', () => {
    const { sink, translator } = setup()
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'child-thread',
      method: 'turn/plan/updated',
      params: { turnId: 'child-turn', plan: [{ step: 'Child task', status: 'inProgress' }] }
    })
    expect(sink.appendItem).toHaveBeenCalled()
    for (const call of sink.appendItem.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('"entries"')
    }
    translator.dispose()
  })

  it('does not publish a checklist that the journal sink refused under pressure', () => {
    const sink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendItem: vi.fn(() => ({ accepted: false as const, reason: 'backpressure' as const }))
    } satisfies StructuredAgentSessionEventSink
    const translator = createCodexJournalTranslator({ sink })
    expect(
      translator.handle({
        type: 'notification',
        sessionId: 'session',
        threadId: 'thread',
        method: 'turn/plan/updated',
        params: { turnId: 'turn', plan: [{ step: 'Keep working', status: 'pending' }] }
      })
    ).toEqual({ accepted: false, reason: 'backpressure' })
    expect(sink.publish).not.toHaveBeenCalled()
    translator.dispose()
  })
})
