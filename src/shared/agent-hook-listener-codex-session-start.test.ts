import { beforeEach, describe, expect, it } from 'vitest'
import { agentEntryCompletionAt } from './agent-completion-time'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { reconcileRemoteCodexState } from './agent-hook-listener/providers/codex-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

describe('native Codex session boundaries', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it.each(['startup', 'resume', 'clear'])(
    'makes %s idle without reporting completed work',
    (source) => {
      const event = normalizeAndAccept(state, 'codex', {
        hook_event_name: 'SessionStart',
        source,
        session_id: '44444444-4444-4444-8444-444444444444',
        model: 'gpt-5.4',
        permission_mode: 'bypassPermissions'
      })

      expect(event?.payload).toMatchObject({
        agentType: 'codex',
        state: 'done',
        sessionBoundary: true,
        model: 'gpt-5.4',
        prompt: ''
      })
      expect(event?.providerSession).toMatchObject({
        id: '44444444-4444-4444-8444-444444444444'
      })
      expect(
        agentEntryCompletionAt({ ...event!.payload, stateStartedAt: 100, stateHistory: [] })
      ).toBeNull()

      const submitted = normalizeAndAccept(state, 'codex', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue the saved request'
      })
      expect(submitted?.payload).toMatchObject({ state: 'working', model: 'gpt-5.4' })
      expect(submitted?.payload.sessionBoundary).toBeUndefined()
    }
  )

  it.each([
    { source: 'compact' },
    { source: 'future-source' },
    {},
    { source: 'startup', agent_id: 'child-1' }
  ])('does not clear an active tool wait for SessionStart %j', (fields) => {
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Continue the work'
    })
    const waiting = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'exec_command',
      tool_input: { cmd: 'git push' }
    })
    const event = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SessionStart',
      ...fields
    })

    expect(event).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(waiting)
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)?.state).toBe('waiting')
    expect(state.lastToolByPaneKey.get(PANE_KEY)?.toolName).toBe('exec_command')
  })

  it('clears stale children when a new process starts at its prompt', () => {
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Old request'
    })
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SubagentStart',
      agent_id: 'child-1'
    })
    const event = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SessionStart',
      source: 'startup'
    })

    expect(event?.payload).toMatchObject({ state: 'done', sessionBoundary: true, prompt: '' })
    expect(event?.payload.subagents).toBeUndefined()
  })

  it('preserves the native session boundary when main reconciles a current relay', () => {
    const relay = createHookListenerState()
    const event = normalizeAndAccept(relay, 'codex', {
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'gpt-5.4'
    })!
    const result = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      event.hookEventName,
      undefined,
      event.payload,
      undefined
    )
    expect(result).toMatchObject({ state: 'done', sessionBoundary: true, model: 'gpt-5.4' })
    expect(agentEntryCompletionAt({ ...result, stateStartedAt: 100, stateHistory: [] })).toBeNull()
  })

  it('does not invent completed work from an older relay without boundary evidence', () => {
    const result = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'SessionStart',
      undefined,
      { state: 'working', prompt: '', agentType: 'codex' },
      undefined
    )
    expect(result.state).toBe('working')
    expect(result.sessionBoundary).toBeUndefined()
  })
})
