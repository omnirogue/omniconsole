import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookSource } from './agent-hook-relay'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import { pendingSessionAsk } from './session-questions'

const GEMINI_ASK = {
  questions: [
    {
      question: 'Which ocean?',
      type: 'choice',
      header: 'Ocean',
      options: [{ label: 'Atlantic' }, { label: 'Pacific' }],
      multiSelect: false
    }
  ]
}
const QWEN_ASK = {
  questions: [
    {
      question: 'Which fruit?',
      header: 'Fruit',
      options: [{ label: 'Apple' }, { label: 'Cherry' }]
    }
  ]
}
const HERMES_ASK = { question: 'Which fruit?', choices: ['Apple', 'Banana', 'Cherry'] }

describe('question hooks from Gemini, Qwen Code and Hermes', () => {
  let state: HookListenerState
  const send = (source: AgentHookSource, payload: Record<string, unknown>) =>
    normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')?.payload

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('Gemini: BeforeTool ask_user waits with the question; AfterTool clears it', () => {
    const asked = send('gemini', {
      hook_event_name: 'BeforeTool',
      tool_name: 'ask_user',
      tool_input: GEMINI_ASK
    })
    expect(asked).toMatchObject({ state: 'waiting', agentType: 'gemini', toolName: 'ask_user' })
    // Why the envelope: older clients read top-level `questions` and would paste labels.
    expect(JSON.parse(asked!.interactivePrompt!)).toEqual({ optionOnlyAsk: GEMINI_ASK })
    expect(pendingSessionAsk(asked!)?.questions[0]?.question).toBe('Which ocean?')

    const answered = send('gemini', {
      hook_event_name: 'AfterTool',
      tool_name: 'ask_user',
      tool_input: GEMINI_ASK,
      tool_response: { llmContent: '{"answers":{"0":"Pacific"}}' }
    })
    expect(answered).toMatchObject({ state: 'working' })
    expect(answered?.interactivePrompt).toBeUndefined()
  })

  it('Gemini: other tools stay working with no prompt', () => {
    const tool = send('gemini', {
      hook_event_name: 'BeforeTool',
      tool_name: 'read_file',
      tool_input: { path: 'a.ts' }
    })
    expect(tool).toMatchObject({ state: 'working' })
    expect(tool?.interactivePrompt).toBeUndefined()
  })

  it('Hermes: pre_tool_call clarify waits with the question; post_tool_call clears it', () => {
    const asked = send('hermes', {
      hook_event_name: 'pre_tool_call',
      tool_name: 'clarify',
      args: HERMES_ASK,
      tool_input: HERMES_ASK
    })
    expect(asked).toMatchObject({ state: 'waiting', agentType: 'hermes', toolName: 'clarify' })
    expect(JSON.parse(asked!.interactivePrompt!)).toEqual({ optionOnlyAsk: HERMES_ASK })
    expect(pendingSessionAsk(asked!)?.questions[0]?.options).toHaveLength(3)

    const answered = send('hermes', {
      hook_event_name: 'post_tool_call',
      tool_name: 'clarify',
      tool_input: HERMES_ASK,
      result: 'Cherry'
    })
    expect(answered).toMatchObject({ state: 'working' })
    expect(answered?.interactivePrompt).toBeUndefined()
  })

  it('Hermes: an open-ended clarify waits but offers no card', () => {
    const asked = send('hermes', {
      hook_event_name: 'pre_tool_call',
      tool_name: 'clarify',
      tool_input: { question: 'Why?' }
    })
    expect(asked).toMatchObject({ state: 'waiting' })
    expect(pendingSessionAsk(asked!)).toBeNull()
  })

  it('Qwen: PermissionRequest ask_user_question is a question, not an approval', () => {
    const asked = send('qwen-code', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'ask_user_question',
      tool_input: QWEN_ASK
    })
    expect(asked).toMatchObject({
      state: 'waiting',
      agentType: 'qwen-code',
      toolName: 'ask_user_question'
    })
    expect(JSON.parse(asked!.interactivePrompt!)).toEqual({ optionOnlyAsk: QWEN_ASK })
    expect(pendingSessionAsk(asked!)?.questions[0]?.options).toHaveLength(2)
  })

  it('Qwen: the permission Notification keeps the card; PreToolUse after the answer clears it', () => {
    send('qwen-code', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'ask_user_question',
      tool_input: QWEN_ASK
    })
    expect(
      send('qwen-code', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    ).toBeUndefined()

    // Why: Qwen fires PreToolUse only after the person answered; it must not reopen the card.
    const pre = send('qwen-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ask_user_question',
      tool_input: QWEN_ASK
    })
    expect(pre).toMatchObject({ state: 'working', toolName: 'ask_user_question' })
    expect(pre?.interactivePrompt).toBeUndefined()

    const post = send('qwen-code', {
      hook_event_name: 'PostToolUse',
      tool_name: 'ask_user_question',
      tool_input: QWEN_ASK,
      tool_response: { llmContent: 'User has provided the following answers: **Fruit**: Cherry' }
    })
    expect(post).toMatchObject({ state: 'working' })
    expect(post?.interactivePrompt).toBeUndefined()
    expect(send('qwen-code', { hook_event_name: 'Stop' })).toMatchObject({ state: 'done' })
  })

  it('Qwen: maps a Claude-compatible turn and ignores an idle SessionStart', () => {
    expect(
      send('qwen-code', { hook_event_name: 'SessionStart', source: 'startup' })
    ).toBeUndefined()
    expect(
      send('qwen-code', { hook_event_name: 'UserPromptSubmit', prompt: 'list files' })
    ).toMatchObject({ state: 'working', prompt: 'list files', agentType: 'qwen-code' })
    const approval = send('qwen-code', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'run_shell_command',
      tool_input: { command: 'ls' }
    })
    expect(approval).toMatchObject({ state: 'waiting', toolName: 'run_shell_command' })
    expect(pendingSessionAsk(approval!)).toBeNull()
    expect(
      send('qwen-code', { hook_event_name: 'PostToolUseFailure', tool_name: 'run_shell_command' })
    ).toMatchObject({ state: 'working' })
  })
  it('Qwen: another tool asked first, then the question — the card follows the question', () => {
    // Why: Qwen fires PermissionRequest for every call at once but shows only the first
    // confirmation; the send path refuses keys until the question's own dialog is on screen.
    send('qwen-code', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'run_shell_command',
      tool_input: { command: 'touch approval-probe.txt' }
    })
    const asked = send('qwen-code', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'ask_user_question',
      tool_input: QWEN_ASK
    })
    expect(asked).toMatchObject({ state: 'waiting', toolName: 'ask_user_question' })
    expect(pendingSessionAsk(asked!)?.questions[0]?.question).toBe('Which fruit?')
  })
})
