import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

const start = {
  paneKey: 'tab-1:leaf-1',
  connectionId: null,
  hookEventName: 'SessionStart',
  payload: { state: 'done', prompt: '', agentType: 'claude' }
} as AgentHookEventPayload

describe('the relay hook envelope', () => {
  it('forwards a SessionStart’s own source, and omits it when there is none', () => {
    expect(
      buildRelayHookEnvelope({ ...start, sessionStartSource: 'startup' }, 'claude')
    ).toMatchObject({ sessionStartSource: 'startup' })
    expect(buildRelayHookEnvelope(start, 'claude')).not.toHaveProperty('sessionStartSource')
  })
})
