// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerSessionManageRequest } from '@/hooks/ipc-events/session-manage-requests'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  pairedSource,
  providerSession
} from '@/lib/mirrored-conversation-test-fixtures'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE
} from '@/lib/sidebar-session-test-fixtures'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { mirroredWorkflowBucketKey } from '@/store/slices/mirrored-workflow-records'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import {
  _resetRenderedSidebarCountsForTests,
  publishRenderedSidebarCounts,
  readRenderedSidebarCounts
} from './rendered-sidebar-counts'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

const initialState = useAppStore.getInitialState()
const W = SESSION_TEST_WORKTREE
const OTHER_W = 'repo-a::/other'

beforeEach(() => {
  _resetRenderedSidebarCountsForTests()
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
})

// Addendum C5 (review C3): `omni session sidebar-counts --json` and `omni session list --json`
// export the same UNFILTERED population — here through the window's two real readers.
describe('the parity population both CLI exports carry', () => {
  it('is the same object from the counts reader and the readParityPopulation relay', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    addSessionTestTab(source, 'tab-local', OTHER_W)
    // A capture the owner holds without listing (held), a slept conversation of the owner's
    // (listed, record row), and a stale bucket from a restored snapshot.
    const capture = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)
    source.sleepingAgentSessionsByPaneKey[capture] = {
      paneKey: capture,
      tabId: capture.split(':')[0],
      worktreeId: W,
      agent: 'claude',
      providerSession: providerSession('held'),
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    Object.assign(
      source,
      ledgerSlices(
        [
          ledgerBucket([
            ledgerRecord('s1', { paneKey: OWNER_PANE }),
            ledgerRecord('slept', { archived: { archived: true } }),
            ledgerRecord('held', { listed: false })
          ]),
          ledgerBucket([ledgerRecord('old')], {
            worktreeId: OTHER_W,
            stale: true,
            ownerState: 'stale'
          })
        ],
        [ledgerOwner()]
      )
    )
    const workflowKey = mirroredWorkflowBucketKey(LEDGER_ENV, W)
    useAppStore.setState({
      ...(source as Partial<typeof initialState>),
      workspaceSessionReady: true,
      runtimeEnvironments: [
        { id: LEDGER_ENV, name: 'Mac Studio' } as PublicKnownRuntimeEnvironment
      ],
      mirroredWorkflowRecordsByOwner: {
        [workflowKey]: {
          environmentId: LEDGER_ENV,
          worktreeId: W,
          records: [{ tabId: 'flow', preset: 'council', title: 'Plan', status: 'done', runId: 'r' }]
        }
      }
    })
    const sessions = buildSidebarSessions(useAppStore.getState())
    expect(sessions.length).toBeGreaterThanOrEqual(5)
    // Why tab-less rows: a deletion mark names a row with no open tab (a tab's row is the tab's).
    const deleted = sessions.find((session) => session.label === 'Owner slept')
    const archived = sessions.find((session) => session.label === 'Owner old')
    expect(deleted && archived).toBeTruthy()
    useSessionSidebarView.setState({
      loaded: true,
      view: { ...emptySessionSidebarView(), deleted: [conversationViewKey(deleted!)] },
      archived: [conversationViewKey(archived!)]
    })
    // The sidebar on screen shows a filtered subset; the population ignores that filter.
    const shown = sessions.filter((session) => session.tabId === tab.id)
    publishRenderedSidebarCounts(
      {},
      {
        countedSessions: shown,
        sessionCounts: new Map([[`runtime:${LEDGER_ENV}`, shown.length]]),
        hostOptions: [
          { id: `runtime:${LEDGER_ENV}`, label: 'Mac Studio', kind: 'runtime', health: 'ready' }
        ],
        hostFilter: { kinds: ['local', 'runtime'], hiddenHostIds: [] },
        archivedCount: 1,
        hiddenCount: 0,
        showArchived: false,
        archivedKeys: new Set([conversationViewKey(archived!)]),
        ready: true
      }
    )

    const counts = readRenderedSidebarCounts()
    const relay = answerSessionManageRequest({ kind: 'readParityPopulation' })
    expect(counts.parity).toBeDefined()
    expect(relay).toEqual(counts.parity)
    const rows = counts.parity!.rows
    expect(rows.length).toBeGreaterThan(shown.length)
    expect(rows.some((row) => row.bucket === 'heldByOwner')).toBe(true)
    expect(rows.some((row) => row.bucket === 'workflow')).toBe(true)
    expect(rows.some((row) => row.stale === true)).toBe(true)
    expect(rows.some((row) => row.archived)).toBe(true)
    // A deleted row is the one thing the population leaves out.
    expect(rows.some((row) => row.label === deleted!.label)).toBe(false)
  })
})
