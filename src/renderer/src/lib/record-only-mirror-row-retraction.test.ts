import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  mirroredConversationBucketKey,
  type MirroredConversationBucket
} from '@/store/slices/mirrored-conversation-ledger'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  sessionConversationIdentity,
  type RuntimeSessionConversationRecord
} from '../../../shared/session-conversation-ledger'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { retractRecordOnlyMirrorRows } from './record-only-mirror-row-retraction'

const initialState = useAppStore.getState()
const LEAF = 'fe7341de-955f-48bc-bdfb-ad8ed4dae623'
const GONE_WT =
  '6bd8d6fa-78dc-452c-b6e3-b8b00d1ab4f9::/Users/maintainer/omnirogue-worktrees/review-1411-1412-opus'

function record(tabId: string, overrides: Partial<SleepingAgentSessionRecord> = {}) {
  return {
    paneKey: makePaneKey(tabId, LEAF),
    tabId,
    worktreeId: GONE_WT,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    origin: 'live',
    ...overrides
  } satisfies SleepingAgentSessionRecord
}

const LAUNCH_CONFIG = {
  identity: { agentType: 'claude', providerSession: { key: 'session_id', id: 'launch-1' } }
} as unknown as AppState['agentLaunchConfigByPaneKey'][string]

afterEach(() => useAppStore.setState(initialState, true))

describe('deleting a record-only row of another computer’s pane (A4)', () => {
  it('drops only that record, sends nothing, and Undo puts it back', () => {
    const stranded = record(toWebTerminalSurfaceTabId('b8fa480c-cd79-4cb2-a1a5-6fcb1945ae70'))
    const local = record('local-tab')
    const withTab = record(toWebTerminalSurfaceTabId('still-open'))
    useAppStore.setState({
      tabsByWorktree: {
        [GONE_WT]: [
          {
            id: withTab.tabId,
            worktreeId: GONE_WT,
            ptyId: null,
            title: 'open',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: Object.fromEntries(
        [stranded, local, withTab].map((entry) => [entry.paneKey, entry])
      ),
      agentLaunchConfigByPaneKey: { [stranded.paneKey]: LAUNCH_CONFIG }
    })

    const undo = retractRecordOnlyMirrorRows([stranded.paneKey, local.paneKey, withTab.paneKey])

    // Why the others stay: a local record is this computer's own session, and a record whose
    // tab is still here belongs to that tab.
    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey).sort()).toEqual(
      [local.paneKey, withTab.paneKey].sort()
    )
    expect(useAppStore.getState().agentLaunchConfigByPaneKey[stranded.paneKey]).toBeUndefined()
    undo()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[stranded.paneKey]).toEqual(
      stranded
    )
    // Why: the clear drops the record's launch config too; Undo must give both back.
    expect(useAppStore.getState().agentLaunchConfigByPaneKey[stranded.paneKey]).toEqual(
      LAUNCH_CONFIG
    )
  })

  it('never throws into the delete it rides on (its toast and Undo must still appear)', () => {
    const stranded = record(toWebTerminalSurfaceTabId('b8fa480c-cd79-4cb2-a1a5-6fcb1945ae70'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [stranded.paneKey]: stranded },
      clearSleepingAgentSessionsByPaneKey: () => {
        throw new Error('store write failed')
      }
    })

    const undo = retractRecordOnlyMirrorRows([stranded.paneKey])

    expect(() => undo()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// Session parity, step 7: `omni session delete --unverified` (and the sidebar) drop a plain-UUID
// capture too — the record the activation sweep re-keyed onto a client-minted tab (C4) — when its
// workspace belongs to a paired computer; a record its owner's ledger lists is not only a copy.
describe('retracting captures under a workspace a paired computer owns (step 7)', () => {
  const STUDIO = '1d045bce-9849-4ceb-94b6-3e36aeca3513'
  const PAIRED_WT = 'paired-repo::/Users/maintainer/Work'
  const MIXED_WT = 'mixed-repo::/Users/maintainer/Work'
  const CLIENT_MINTED = '7c2d9f1e-0a4b-4c6d-8e1f-2a3b4c5d6e7f'

  function ledgerRecord(
    capture: SleepingAgentSessionRecord,
    listed: boolean
  ): RuntimeSessionConversationRecord {
    return {
      conversation: sessionConversationIdentity(capture),
      agent: capture.agent,
      providerSession: { key: capture.providerSession.key, id: capture.providerSession.id },
      title: 'owner title',
      titleSource: 'custom',
      surface: 'record',
      rest: 'asleep',
      listed,
      updatedAt: 1
    }
  }

  function bucket(records: RuntimeSessionConversationRecord[]): MirroredConversationBucket {
    return {
      environmentId: STUDIO,
      worktreeId: PAIRED_WT,
      records,
      coverage: { complete: true },
      source: 'window',
      generation: 'gen-1',
      revision: 3,
      listedAt: 1,
      ownerState: 'ready',
      asOf: 1
    }
  }

  function seed(
    captures: SleepingAgentSessionRecord[],
    records: RuntimeSessionConversationRecord[] = []
  ): void {
    useAppStore.setState({
      repos: [
        { id: 'paired-repo', executionHostId: `runtime:${STUDIO}` },
        { id: 'mixed-repo', executionHostId: `runtime:${STUDIO}` },
        { id: 'mixed-repo', executionHostId: 'local' }
      ],
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: Object.fromEntries(
        captures.map((entry) => [entry.paneKey, entry])
      ),
      mirroredConversationLedgerByOwner: {
        [mirroredConversationBucketKey(STUDIO, PAIRED_WT)]: bucket(records)
      }
    } as never)
  }

  it('retracts a plain-UUID capture of a peer workspace, and Undo puts it back', () => {
    const capture = record(CLIENT_MINTED, { worktreeId: PAIRED_WT })
    seed([capture])

    const undo = retractRecordOnlyMirrorRows([capture.paneKey])

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[capture.paneKey]).toBeUndefined()
    undo()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[capture.paneKey]).toEqual(capture)
  })

  it('keeps a plain-UUID record of a workspace no single owner is credited with', () => {
    const unresolved = record(CLIENT_MINTED, { worktreeId: MIXED_WT })
    seed([unresolved])

    retractRecordOnlyMirrorRows([unresolved.paneKey])

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[unresolved.paneKey]).toEqual(
      unresolved
    )
  })

  it('leaves a vouched row untouched: its owner lists the conversation, whatever its pane id', () => {
    const plain = record(CLIENT_MINTED, { worktreeId: PAIRED_WT })
    const mirror = record(toWebTerminalSurfaceTabId('9526cd53-8dc2-43b3-9ee2-4054a8a372fb'), {
      worktreeId: PAIRED_WT
    })
    seed([plain, mirror], [ledgerRecord(plain, true), ledgerRecord(mirror, true)])

    retractRecordOnlyMirrorRows([plain.paneKey, mirror.paneKey])

    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey).sort()).toEqual(
      [plain.paneKey, mirror.paneKey].sort()
    )
  })

  it('lets the person drop a capture the owner only holds as passive evidence (listed: false)', () => {
    const held = record(CLIENT_MINTED, { worktreeId: PAIRED_WT })
    seed([held], [ledgerRecord(held, false)])

    retractRecordOnlyMirrorRows([held.paneKey])

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[held.paneKey]).toBeUndefined()
  })
})
