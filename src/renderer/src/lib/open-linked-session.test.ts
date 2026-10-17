import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: [] as {
    sessionKey: string
    hostId: string
    paneKey: string
    providerSession: { id: string }
  }[],
  activate: vi.fn(),
  console: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./sidebar-sessions', () => ({ buildSidebarSessions: () => mocks.sessions }))
vi.mock('./activate-sidebar-session', () => ({ activateSidebarSession: mocks.activate }))
vi.mock('./session-ledger-console', () => ({ openSessionLedgerConsole: mocks.console }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
import { openLinkedSession } from './open-linked-session'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activate.mockResolvedValue({ handled: 'opened' })
  mocks.sessions = [
    {
      sessionKey: 'local|same',
      hostId: 'local',
      paneKey: 'same',
      providerSession: { id: 'native' }
    },
    {
      sessionKey: 'runtime:remote|same',
      hostId: 'runtime:remote',
      paneKey: 'same',
      providerSession: { id: 'native' }
    }
  ]
})

describe('linked session host identity', () => {
  it('uses a host-qualified session key', () => {
    openLinkedSession({ sessionLedgerId: 'als_1', sessionKey: 'runtime:remote|same' })
    expect(mocks.activate).toHaveBeenCalledWith(mocks.sessions[1])
  })

  it.each([{ paneKey: 'same' }, { nativeSessionId: 'native' }])(
    'qualifies a shared handle by its execution host (%j)',
    (handle) => {
      openLinkedSession({ sessionLedgerId: 'als_1', executionHostId: 'runtime:remote', ...handle })
      expect(mocks.activate).toHaveBeenCalledWith(mocks.sessions[1])
    }
  )

  it.each([undefined, 'runtime:missing'])(
    'opens the ledger page when ownership is unavailable (%s)',
    (executionHostId) => {
      openLinkedSession({
        sessionLedgerId: 'als_1',
        executionHostId,
        paneKey: 'same',
        nativeSessionId: 'native'
      })
      expect(mocks.activate).not.toHaveBeenCalled()
      expect(mocks.console).toHaveBeenCalledWith('als_1')
    }
  )
})
