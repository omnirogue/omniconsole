import { expect, it } from 'vitest'
import {
  boardConversationRequest,
  boardConversationResponse,
  boardConversationTurn,
  boardMessageRequest,
  boardMessageResponse,
  teamRoutineRuns
} from './console-routine-conversation-contract'

it('decodes named run fields, null legacy cards and future fields', () => {
  const rows = [
    {
      id: 'rr_1',
      routine_id: 'rtn_demo',
      gate_passed: true,
      accepted: null,
      finished_at: null,
      board_task_id: 'btk_demo',
      session_id: null,
      future: 1
    },
    { board_task_id: null, gate_passed: null }
  ]
  expect(teamRoutineRuns.parse(rows)).toEqual(rows)
  expect(teamRoutineRuns.safeParse([{ accepted: 'yes' }]).success).toBe(false)
})
it('decodes BFF text turns and hub content turns without restricting roles', () => {
  const messages = [
    { id: 'cnv_1', role: 'system', text: 'Review denied', created_at: '2026-09-18', future: true }
  ]
  expect(boardConversationResponse.parse({ ok: true, messages, future: 2 })).toEqual({
    ok: true,
    messages,
    future: 2
  })
  expect(
    boardConversationTurn.parse({
      role: 'user',
      content: 'Hello',
      delivery_status: { pending: true }
    }).content
  ).toBe('Hello')
  expect(boardConversationResponse.safeParse({ ok: true, messages: 'bad' }).success).toBe(false)
})
it('decodes the actual send_work_action envelope without losing either delivery flag', () => {
  const response = {
    ok: true,
    status: 200,
    payload: {
      id: 'cnv_2',
      role: 'user',
      content: 'Hello',
      delivered_live: true,
      queued_for_next_attempt: true,
      future: 3
    }
  }
  expect(boardMessageResponse.parse(response)).toEqual(response)
  expect(
    boardMessageResponse.parse({
      ok: false,
      reason: 'Membership changed',
      code: 'board_message_forbidden'
    }).reason
  ).toBe('Membership changed')
  expect(
    boardMessageResponse.safeParse({ ok: true, payload: { delivered_live: 'yes' } }).success
  ).toBe(false)
})
it('allows only content and a validated task ID in write requests', () => {
  expect(boardConversationRequest.parse({ taskId: 'btk_demo' })).toEqual({ taskId: 'btk_demo' })
  expect(boardMessageRequest.safeParse({ taskId: 'btk_demo', content: ' ' }).success).toBe(false)
  expect(
    boardMessageRequest.safeParse({ taskId: 'btk_demo', content: 'Hello', idempotency_key: 'no' })
      .success
  ).toBe(false)
})
