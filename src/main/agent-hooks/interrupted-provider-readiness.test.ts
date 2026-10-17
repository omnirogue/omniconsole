import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { createInterruptedSessionContinuation } from './interrupted-session-continuation'
import { buildBody, PANE } from './server.test-fixtures'

describe.each([
  ['gemini', 'SessionStart'],
  ['grok', 'session_start'],
  ['grok', 'SessionStart'],
  ['pi', 'session_start'],
  ['opencode', 'SessionStart']
] as const)('%s %s continuation boundary', (provider, eventName) => {
  function fixture(enabled = true) {
    const state = createHookListenerState()
    state.lastPromptByPaneKey.set(PANE, 'stale prompt')
    const event = normalizeHookPayload(
      state,
      provider,
      buildBody(
        {
          hook_event_name: eventName,
          source: 'resume',
          session_id: 'thread',
          sessionID: 'thread',
          session_file: '/tmp/thread.jsonl'
        },
        { launchToken: 'replacement' }
      ),
      'production'
    )!
    const claim = vi.fn(() => true)
    const send = vi.fn(async (beforeWrite: () => void) => beforeWrite())
    const controller = createInterruptedSessionContinuation({
      previous: {
        paneKey: PANE,
        connectionId: null,
        agentType: provider,
        state: 'working',
        prompt: 'interrupted task',
        stateStartedAt: 1,
        receivedAt: 2,
        providerSession: event.providerSession
      },
      launchToken: 'replacement',
      enabled: () => enabled,
      claim,
      send,
      record: vi.fn()
    })
    return { event, state, claim, send, controller }
  }

  it('delivers the normalized boundary once after successful resume', () => {
    const f = fixture()
    if (provider === 'grok' || provider === 'pi') {
      expect(f.event.providerSessionOnly).toBe(true)
      expect(f.event.hookEventName).toBe('session_start')
      expect(f.event.payload.state).toBe('done')
      expect(f.state.lastPromptByPaneKey.has(PANE)).toBe(false)
    } else {
      expect(f.event.payload.sessionBoundary).toBe(true)
    }
    f.controller.observe(f.event)
    expect(f.send).not.toHaveBeenCalled()
    f.controller.commit(true)
    f.controller.observe(f.event)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.claim).toHaveBeenCalledTimes(1)
  })

  it('ignores replay and old-launch readiness, then accepts the live event', () => {
    const f = fixture()
    f.controller.commit(true)
    f.controller.observe({ ...f.event, isReplay: true })
    f.controller.observe({ ...f.event, launchToken: 'old' })
    expect(f.send).not.toHaveBeenCalled()
    f.controller.observe(f.event)
    f.controller.observe({ ...f.event, isReplay: true })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('refuses a fresh provider session on the resumed pane', () => {
    const f = fixture()
    f.controller.commit(true)
    f.controller.observe({
      ...f.event,
      providerSession: { ...f.event.providerSession!, id: 'fresh' }
    })
    f.controller.observe(f.event)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('refuses disabled continuation and failed spawn', () => {
    const disabled = fixture(false)
    disabled.controller.commit(true)
    disabled.controller.observe(disabled.event)
    expect(disabled.send).not.toHaveBeenCalled()
    const failed = fixture()
    failed.controller.observe(failed.event)
    failed.controller.commit(false)
    expect(failed.send).not.toHaveBeenCalled()
  })
})
