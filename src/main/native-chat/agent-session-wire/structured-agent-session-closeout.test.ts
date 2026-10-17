import { describe, expect, it, vi } from 'vitest'
import {
  evictHeldStructuredAgentSession,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
vi.mock('./structured-agent-session-lease-release', () => ({
  releaseStoredStructuredAgentSessionOwner: vi.fn()
}))

describe('delayed closeout release ownership', () => {
  it.each(['journal', 'fence', 'mutated-fence'] as const)(
    'does not release or forget a replacement %s after saving',
    async (change) => {
      vi.mocked(releaseStoredStructuredAgentSessionOwner).mockClear()
      const entered = Promise.withResolvers<void>()
      const saved = Promise.withResolvers<void>()
      const record = { hubTaskId: 'btk_1234', lease: { runtimeFence: 1 } }
      const session = {
        hasProviderChild: true,
        fence: 1,
        journal: { cursor: () => ({ epoch: 'epoch', sequence: 2 }) }
      }
      const sessions = new Map([['session', session]])
      const context = {
        deps: {
          store: { getRecord: () => record },
          adapter: { closeSession: async () => true },
          onSessionStopped: async () => {
            entered.resolve()
            await saved.promise
          }
        },
        sessions,
        now: () => 1,
        runtimeState: {
          eventSinkFor: () => ({
            drained: async () => ({ ok: true }),
            unbind: () => {},
            close: () => {}
          }),
          discardEventSink: () => {}
        }
      } as unknown as StructuredAgentSessionLifetimeContext
      const closing = evictHeldStructuredAgentSession(context, 'session')
      await entered.promise
      if (change === 'journal') {
        sessions.set('session', { ...session })
      } else {
        record.lease.runtimeFence = 2
        if (change === 'mutated-fence') {
          session.fence = 2
        }
      }
      saved.resolve()
      await expect(closing).rejects.toThrow('release-lease')
      expect(releaseStoredStructuredAgentSessionOwner).not.toHaveBeenCalled()
      expect(sessions.has('session')).toBe(true)
    }
  )
})
