import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  compactAnswerEvent,
  HOOK_ANSWER_ACK_WAIT_MS,
  HOOK_ANSWER_OPEN_WINDOW_MS,
  HookAnswerGate,
  hookAnswerReplyOpen,
  hookAnswerResponseBody
} from './hook-answer-gate'

const request = (headers: Record<string, string> = {}, destroyed = false) =>
  ({ headers, socket: { destroyed } }) as unknown as IncomingMessage

function response() {
  const res = new EventEmitter() as EventEmitter & { writableFinished: boolean }
  res.writableFinished = false
  return res
}

function gateWith() {
  const replies = { reply: vi.fn(), ack: vi.fn(() => true), expire: vi.fn(), confirm: vi.fn() }
  const gate = new HookAnswerGate()
  gate.set(replies)
  return { gate, replies }
}

const REPLY = { body: '{}', ack: 'wd-1 nonce-1', continuesTurn: true }

describe('hook answer gate', () => {
  it('hands out an answer only while the hook can still read the reply', () => {
    const opened = 10_000
    expect(hookAnswerReplyOpen(request(), opened, opened + HOOK_ANSWER_OPEN_WINDOW_MS)).toBe(true)
    expect(hookAnswerReplyOpen(request(), opened, opened + HOOK_ANSWER_OPEN_WINDOW_MS + 1)).toBe(
      false
    )
    expect(hookAnswerReplyOpen(request({}, true), opened, opened)).toBe(false)
    expect(hookAnswerReplyOpen(request({ 'x-omni-agent-hook-late': '1' }), opened, opened)).toBe(
      false
    )
    expect(hookAnswerResponseBody(REPLY)).toBe('omni-answer wd-1 nonce-1\n{}')
  })

  it('an acknowledged reply is settled; an unacknowledged one is expired after the wait', () => {
    vi.useFakeTimers()
    try {
      const { gate, replies } = gateWith()
      const unacked = vi.fn()
      gate.track(response() as unknown as ServerResponse, REPLY, unacked)
      expect(gate.ack({ ack: 'wd-1 nonce-1' })).toBe(true)
      vi.advanceTimersByTime(HOOK_ANSWER_ACK_WAIT_MS + 1)
      expect(unacked).not.toHaveBeenCalled()
      expect(replies.expire).not.toHaveBeenCalled()

      gate.track(response() as unknown as ServerResponse, { ...REPLY, ack: 'wd-2 n2' }, unacked)
      vi.advanceTimersByTime(HOOK_ANSWER_ACK_WAIT_MS - 1)
      expect(unacked).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(replies.expire).toHaveBeenCalledWith('wd-2 n2')
      expect(unacked).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a connection closed before the reply finished is unacknowledged at once', () => {
    const { gate, replies } = gateWith()
    const unacked = vi.fn()
    const res = response()
    gate.track(res as unknown as ServerResponse, REPLY, unacked)
    res.emit('close')
    expect(replies.expire).toHaveBeenCalledWith('wd-1 nonce-1')
    expect(unacked).toHaveBeenCalledTimes(1)
    expect(gate.ack({})).toBe(false)
  })

  it('turns a compaction SessionStart into a bare event of its pane and launch, and nothing else', () => {
    const body = {
      paneKey: 'tab-1:leaf-1',
      launchToken: 'launch-1',
      agentPid: '4242',
      payload: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' })
    }
    expect(compactAnswerEvent('claude', body)).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      launchToken: 'launch-1',
      agentPid: 4242,
      hookEventName: 'SessionStart'
    })
    const resume = { ...body, payload: { hook_event_name: 'SessionStart', source: 'resume' } }
    expect(compactAnswerEvent('claude', resume)).toBeNull()
    expect(compactAnswerEvent('gemini', body)).toBeNull()
    expect(compactAnswerEvent('codex', { ...body, paneKey: '' })).toBeNull()
  })

  it('holds slim copies of replayed records until the inbox is installed, then confirms with them', () => {
    const gate = new HookAnswerGate()
    const big = 'x'.repeat(100_000)
    gate.replayed({
      source: 'claude',
      body: {
        payload: { hook_event_name: 'Stop', session_id: 'conv-1', last_assistant_message: big }
      },
      event: {
        paneKey: 'p',
        launchToken: 'l',
        connectionId: null,
        payload: { prompt: big }
      } as never,
      at: 1
    })
    const replies = { reply: vi.fn(), ack: vi.fn(), expire: vi.fn(), confirm: vi.fn() }
    gate.set(replies)
    expect(replies.confirm).toHaveBeenCalledWith({
      source: 'claude',
      at: 1,
      body: {
        payload: {
          hook_event_name: 'Stop',
          session_id: 'conv-1',
          transcript_path: undefined,
          agent_id: undefined
        }
      },
      event: expect.objectContaining({ paneKey: 'p', launchToken: 'l', payload: {} })
    })
    replies.reply.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(
      gate.reply({
        source: 'claude',
        body: {},
        event: {} as never,
        pointer: null,
        deliverable: () => true
      })
    ).toBeNull()
  })
})
