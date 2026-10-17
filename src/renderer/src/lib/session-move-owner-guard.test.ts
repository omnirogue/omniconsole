import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { conversationViewKey } from './conversation-view'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  pairedSource
} from './mirrored-conversation-test-fixtures'
import { movableSessionKeys } from './session-move-owner-guard'
import { addSessionTestTab } from './sidebar-session-test-fixtures'
import { buildSidebarSessions } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
})

// E1 for filing (session parity, Phase 1b): every move path hands its keys through this guard.
describe('movableSessionKeys', () => {
  it('keeps the rows this computer files and refuses, once per computer, the ones an owner places', () => {
    const source = pairedSource()
    addMirrorTab(source)
    addSessionTestTab(source, 'tab-local')
    Object.assign(
      source,
      ledgerSlices([ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE, folderId: null })])])
    )
    useAppStore.setState({
      ...(source as Partial<typeof initialState>),
      runtimeEnvironments: [{ id: LEDGER_ENV, name: 'Mac Studio' } as PublicKnownRuntimeEnvironment]
    })
    const rows = buildSidebarSessions(source)
    const placed = rows.find((row) => row.mirroredConversation)!
    const local = rows.find((row) => row.tabId === 'tab-local')!
    const keys = [conversationViewKey(placed), conversationViewKey(local), 'routine:weekly']

    expect(movableSessionKeys(keys)).toEqual([conversationViewKey(local), 'routine:weekly'])
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Open it on Mac Studio.')
  })

  it('refuses nothing, and says nothing, when no key names a row an owner places', () => {
    expect(movableSessionKeys(['a', 'b'])).toEqual(['a', 'b'])
    expect(movableSessionKeys([])).toEqual([])
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
