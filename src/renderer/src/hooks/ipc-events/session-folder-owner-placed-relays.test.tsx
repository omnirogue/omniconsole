// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  OWNER_TAB,
  pairedSource
} from '@/lib/mirrored-conversation-test-fixtures'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SessionFolderRendererRequestPayload } from '../../../../shared/session-folder-cli'
import { registerSessionFolderRequestIpcBridge } from './session-folder-request-ipc-bridge'
import { answerSessionManageRequest } from './session-manage-requests'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

const initialState = useAppStore.getInitialState()
const OPEN_ON = 'Open it on Mac Studio.'
const replies: unknown[] = []
let onRequest: ((payload: SessionFolderRendererRequestPayload) => void) | null = null
const unsubs: (() => void)[] = []

/** The one row of a paired receiver: a joined row the owner places, or a row the ledger created. */
function seed(kind: 'placed' | 'ledger-only'): SidebarSession {
  const source = pairedSource()
  if (kind === 'placed') {
    addMirrorTab(source)
  } else {
    // A dormant mirror tab no row was built for: the ledger's record becomes the row on it.
    addMirrorTab(source, OWNER_TAB, null)
  }
  Object.assign(
    source,
    ledgerSlices([
      ledgerBucket([
        ledgerRecord('s1', {
          paneKey: OWNER_PANE,
          ...(kind === 'placed' ? { folderId: null } : { rest: 'asleep' })
        })
      ])
    ])
  )
  useAppStore.setState({
    ...(source as Partial<typeof initialState>),
    workspaceSessionReady: false,
    runtimeEnvironments: [{ id: LEDGER_ENV, name: 'Mac Studio' } as PublicKnownRuntimeEnvironment]
  })
  const rows = buildSidebarSessions(source)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  replies.length = 0
  onRequest = null
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onRequestSessionFolders: (listener: typeof onRequest) => {
          onRequest = listener
          return () => {}
        },
        replySessionFolders: (reply: unknown) => replies.push(reply)
      }
    }
  })
})

afterEach(() => {
  for (const unsub of unsubs.splice(0)) {
    unsub()
  }
  useAppStore.setState(initialState, true)
})

// E1 (session parity, Phase 1b): the relays refuse what the sidebar's own actions refuse, with
// the same words, instead of writing a membership or a name that could never show.
describe('the CLI relays and rows a paired owner files or created', () => {
  it('refuses `omni session move` on a row its owner places, naming the computer', async () => {
    const placed = seed('placed')
    expect(placed.mirroredConversation?.folderIdByOwner).toBeNull()
    registerSessionFolderRequestIpcBridge(unsubs)
    onRequest!({
      requestId: 'move-1',
      request: {
        kind: 'mutate',
        op: { kind: 'moveSession', paneKey: placed.paneKey!, destination: 'folder', folder: 'Ads' }
      }
    })
    await settled()
    expect(replies).toEqual([{ requestId: 'move-1', ok: false, error: OPEN_ON }])
  })

  it('refuses the rename relay on a row the ledger created, even on a pending-handle tab', () => {
    const ledgerOnly = seed('ledger-only')
    expect(ledgerOnly.tabId).not.toBeNull()
    expect(() =>
      answerSessionManageRequest({
        kind: 'renameSession',
        paneKey: ledgerOnly.paneKey!,
        title: 'Renamed here'
      })
    ).toThrow(OPEN_ON)
  })
})
