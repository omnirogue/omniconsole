import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

describe('fresh conversation provenance', () => {
  it.each(['claude', 'codex', 'gemini'] as const)(
    'retains %s startup versus resume evidence',
    (provider) => {
      for (const source of ['startup', 'resume', 'clear']) {
        const event = normalizeAndAccept(createHookListenerState(), provider, {
          hook_event_name: 'SessionStart',
          source
        })
        expect(event?.payload.state).toBe('done')
        expect(event?.sessionStartSource).toBe(source)
      }
    }
  )
  it('does not infer startup from an empty normalized event', () => {
    const event = normalizeAndAccept(createHookListenerState(), 'claude', {
      hook_event_name: 'Stop'
    })
    expect(event?.sessionStartSource).toBeUndefined()
  })
})
