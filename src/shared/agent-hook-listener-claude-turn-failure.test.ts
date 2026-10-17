import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

// Why these exist: a Claude turn that died on a quota wall nine seconds after its prompt landed
// reported `state: 'done', interrupted: false` — byte-identical to success — so every consumer
// waiting on that turn waited forever. The distinction has to survive normalization.
describe('Claude failed turn boundaries', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function submitPrompt(): void {
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' } },
      'production'
    )
  }

  it('marks a StopFailure done as failed and carries the quota wall it died on', () => {
    submitPrompt()
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'StopFailure',
          last_assistant_message:
            "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models."
        }
      },
      'production'
    )
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.failed).toBe(true)
    // The turn was not cancelled by the person; a chain must not park on it.
    expect(event?.payload.interrupted).toBeUndefined()
    expect(event?.payload.failureReason).toContain('out of usage credits')
    // Provider error prose still stays out of the agent's "reply" field (unchanged contract).
    expect(event?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('fails loudly when the provider explains nothing', () => {
    submitPrompt()
    const event = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'StopFailure' } },
      'production'
    )
    expect(event?.payload).toMatchObject({ state: 'done', failed: true })
    expect(event?.payload.failureReason).toBeUndefined()
  })

  it('falls back to the provider error detail when there is no last line', () => {
    submitPrompt()
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'StopFailure',
          error: 'invalid_request',
          error_details: 'model is not supported'
        }
      },
      'production'
    )
    expect(event?.payload.failureReason).toBe('model is not supported')
  })

  it('leaves an ordinary Stop completing normally', () => {
    submitPrompt()
    const event = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'Stop' } },
      'production'
    )
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.failed).toBeUndefined()
    expect(event?.payload.failureReason).toBeUndefined()
  })

  it('keeps an interrupted turn an interrupt, never a failure', () => {
    submitPrompt()
    const event = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'Stop', is_interrupt: true } },
      'production'
    )
    expect(event?.payload).toMatchObject({ state: 'done', interrupted: true })
    expect(event?.payload.failed).toBeUndefined()
  })
})
