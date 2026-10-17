import { describe, expect, it } from 'vitest'
import { readCodexRolloutTurnResult } from './codex-rollout-turn-result'

/** Line shapes from the real 2026-09-20 rollout of the local Advertising routine. */
const line = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type, payload })
const REPORT = '**Old AI Creator Secrets: $421.89 spent today.**\n\n```omni-actions\n[]\n```'
const RUN_STARTED_AT = Date.parse('2026-09-20T20:00:03.283Z')

const rollout = [
  line('2026-09-20T19:37:20.938Z', 'event_msg', {
    type: 'task_complete',
    turn_id: 'previous',
    last_agent_message: 'Got it—thanks for confirming.'
  }),
  line('2026-09-20T20:00:03.462Z', 'event_msg', { type: 'task_started', turn_id: 'run-7' }),
  line('2026-09-20T20:00:03.483Z', 'turn_context', { turn_id: 'run-7' }),
  line('2026-09-20T20:00:03.654Z', 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'OLD AI CREATOR SECRETS ADVERTISING ROUTINE' }]
  }),
  line('2026-09-20T20:00:10.155Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'I’ll refresh Meta, Stripe and WebinarJam.' }]
  }),
  line('2026-09-20T20:08:33.801Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: REPORT }]
  })
]

describe('readCodexRolloutTurnResult', () => {
  it('returns the completed turn message written after the run started', () => {
    const complete = line('2026-09-20T20:08:33.887Z', 'event_msg', {
      type: 'task_complete',
      turn_id: 'run-7',
      last_agent_message: REPORT
    })
    const later = line('2026-09-20T20:20:32.062Z', 'event_msg', {
      type: 'task_complete',
      turn_id: 'sal-chat',
      last_agent_message: 'Yes—all three Enterprise campaigns target the US only.'
    })
    expect(
      readCodexRolloutTurnResult([...rollout, complete, later].join('\n'), RUN_STARTED_AT)
    ).toEqual({ message: REPORT, completedAt: Date.parse('2026-09-20T20:08:33.887Z') })
  })
  it('falls back to the last assistant item when task_complete carries no message', () => {
    const complete = line('2026-09-20T20:08:33.887Z', 'event_msg', { type: 'task_complete' })
    expect(readCodexRolloutTurnResult([...rollout, complete].join('\n'), RUN_STARTED_AT)).toEqual({
      message: REPORT,
      completedAt: Date.parse('2026-09-20T20:08:33.887Z')
    })
  })
  it('reports no turn when the rollout only has the previous run and a started-but-aborted turn', () => {
    const aborted = [
      rollout[0],
      line('2026-09-20T20:14:41.356Z', 'event_msg', { type: 'task_started', turn_id: 'lock' }),
      'not json at all {'
    ]
    expect(
      readCodexRolloutTurnResult(aborted.join('\n'), Date.parse('2026-09-20T20:15:25.996Z'))
    ).toBeNull()
    expect(readCodexRolloutTurnResult('', RUN_STARTED_AT)).toBeNull()
  })
})
