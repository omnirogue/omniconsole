import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../agent-hook-listener'
import { PANE_KEY } from '../agent-hook-listener-test-harness'
import { pendingSessionAsk } from '../session-questions'
import { createHookListenerState, type HookListenerState } from './listener-state'
import { dismissCodexAsyncQuestions } from './providers/codex-async-ask-tracking'
import { setTurnEndGeneralQuestionsResolver } from './turn-end-question'
import { readCurrentTurnAssistantText } from './turn-end-transcript'

const SIGN_IN =
  'Zapier: https://zapier.com/app/login?next=%2Fapp\n\nPlease sign in there, then let me know once you are done.'

function sender(state: HookListenerState, source: 'claude' | 'kimi' | 'codex') {
  return (payload: Record<string, unknown>) =>
    normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')!.payload
}

afterEach(() => setTurnEndGeneralQuestionsResolver(() => false))

describe('a turn-end sign-in ask at Stop', () => {
  it("rides a Claude turn's end as an async question", () => {
    const send = sender(createHookListenerState(), 'claude')
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'connect zapier' })
    const ask = pendingSessionAsk(
      send({ hook_event_name: 'Stop', last_assistant_message: SIGN_IN })
    )
    expect(ask?.delivery).toBe('async')
    expect(ask?.questions[0]?.question).toContain('https://zapier.com/app/login?next=%2Fapp')
  })

  it('is not raised for a Claude-shaped agent whose answers are not guarded (Kimi)', () => {
    const send = sender(createHookListenerState(), 'kimi')
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'connect zapier' })
    const stop = send({ hook_event_name: 'Stop', last_assistant_message: SIGN_IN })
    expect(stop.interactivePrompt).toBeUndefined()
  })

  it('keeps a plain closing question out of the row while the setting is off', () => {
    const send = sender(createHookListenerState(), 'claude')
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor' })
    const stop = send({ hook_event_name: 'Stop', last_assistant_message: 'Should I merge it now?' })
    expect(pendingSessionAsk(stop)).toBeNull()
    setTurnEndGeneralQuestionsResolver(() => true)
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor again' })
    const asked = send({
      hook_event_name: 'Stop',
      last_assistant_message: 'Should I merge it now?'
    })
    expect(pendingSessionAsk(asked)?.questions[0]?.question).toBe('Should I merge it now?')
  })
})

describe('dismissing a native Codex question its final message repeats', () => {
  it('does not come back from the inferred copy on a later child event', () => {
    setTurnEndGeneralQuestionsResolver(() => true)
    const state = createHookListenerState()
    const send = sender(state, 'codex')
    const input = { questions: [{ title: 'Which color do you prefer?', options: ['Red', 'Blue'] }] }
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'ask me' })
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: input,
      tool_use_id: 'c1'
    })
    send({
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: input,
      tool_response: '{"accepted":true}',
      tool_use_id: 'c1'
    })
    const stop = send({
      hook_event_name: 'Stop',
      last_assistant_message: 'Which color do you prefer?'
    })
    const shown = pendingSessionAsk(stop)!.questions
    expect(shown.map((question) => question.question)).toEqual(['Which color do you prefer?'])
    dismissCodexAsyncQuestions(state, PANE_KEY, stop.interactivePrompt, shown)
    const child = send({
      hook_event_name: 'SubagentStart',
      agent_id: 'child-1',
      agent_type: 'worker'
    })
    expect(pendingSessionAsk(child)).toBeNull()
  })
})

describe("a Codex turn's own words", () => {
  it('leave out analysis text and keep what the person sees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-end-'))
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(path, '')
    const line = (record: unknown) => appendFileSync(path, `${JSON.stringify(record)}\n`)
    const said = (phase: string | undefined, text: string) =>
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          ...(phase ? { phase } : {}),
          content: [{ type: 'output_text', text }]
        }
      })
    try {
      line({ type: 'event_msg', payload: { type: 'task_started' } })
      said('analysis', 'Hypothetically: please sign in at https://example.com/login')
      said('commentary', 'Checking the build.')
      said(undefined, 'An older record with no phase.')
      said('final_answer', 'I am monitoring the build.')
      expect(readCurrentTurnAssistantText(path, undefined)).toBe(
        'Checking the build.\n\nAn older record with no phase.\n\nI am monitoring the build.'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
