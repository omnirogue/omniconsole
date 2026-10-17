import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const RECORD = {
  paneKey: PANE,
  tabId: 'tab-1',
  worktreeId: 'w',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'conv' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  restoreOnTabOpenOnly: true,
  resumeOnFirstReveal: true
} as SleepingAgentSessionRecord

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, onScreen: false }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/lib/idle-auto-close/idle-keep-guards', () => ({
  isTerminalTabOnScreen: () => store.onScreen
}))

const { sleptPaneParkedNow } = await import('./slept-pane-parked-now')

function stateWith(record: SleepingAgentSessionRecord | undefined, livePtys: string[] = []) {
  return {
    sleepingAgentSessionsByPaneKey: record ? { [PANE]: record } : {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { 'tab-1': livePtys }
  }
}

describe('a slept pane parked right now', () => {
  beforeEach(() => {
    store.state = stateWith(RECORD)
    store.onScreen = false
    vi.stubGlobal('window', { api: { pty: { hasPty: vi.fn(async () => false) } } })
  })

  it('is parked when the daemon says its PTY is gone and nothing changed meanwhile', async () => {
    expect(await sleptPaneParkedNow(PANE)).toBe(true)
  })

  it('is not parked once a person opens the tab or its restore replaces the checkpoint', async () => {
    store.onScreen = true
    expect(await sleptPaneParkedNow(PANE)).toBe(false)
    store.onScreen = false
    vi.stubGlobal('window', {
      api: {
        pty: {
          hasPty: vi.fn(async () => {
            store.state = stateWith({ ...RECORD, updatedAt: 2 }, ['pty-2'])
            return false
          })
        }
      }
    })
    expect(await sleptPaneParkedNow(PANE)).toBe(false)
  })

  it('is not parked without a checkpoint or a daemon answer', async () => {
    store.state = stateWith(undefined)
    expect(await sleptPaneParkedNow(PANE)).toBe(false)
    store.state = stateWith(RECORD)
    vi.stubGlobal('window', { api: { pty: { hasPty: vi.fn(async () => null) } } })
    expect(await sleptPaneParkedNow(PANE)).toBe(false)
  })
})
