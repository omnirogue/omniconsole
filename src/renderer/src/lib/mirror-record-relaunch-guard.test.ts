import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Repo } from '../../../shared/repo-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  isMirrorRecordRelaunchRefused,
  isNonOwnedWorkspaceRecordLaunchRefused,
  mirrorRecordRelaunchRefusalReason,
  type MirrorRecordRelaunchState
} from './mirror-record-relaunch-guard'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'

const initialStoreState = useAppStore.getState()
const MACBOOK = '93513683-3ff0-4499-bd79-3c03122c7365'
const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
const PAIRED_WT = 'paired-repo::/Users/maintainer/omni-ide-worktrees/omni-ide/rel-review-1004'
const LOCAL_WT = 'local-repo::/Users/maintainer/project'
const LEGACY_TAB = toWebTerminalSurfaceTabId('host-tab')

function record(tabId: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(tabId, LEAF),
    tabId,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-session' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit'
  }
}

function husk(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: ptyId }
  }
}

function tab(id: string, worktreeId: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

function state(extra: Partial<MirrorRecordRelaunchState> = {}): MirrorRecordRelaunchState {
  return {
    repos: [
      { id: 'paired-repo', executionHostId: `runtime:${MACBOOK}` },
      { id: 'local-repo', executionHostId: 'local' }
    ] as unknown as Repo[],
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...extra
  }
}

describe('which records of web-terminal panes may relaunch (A4)', () => {
  it("lets this computer's own legacy record resume after its tab closed (local husk PTY)", () => {
    const own = record(LEGACY_TAB, LOCAL_WT)
    expect(
      isMirrorRecordRelaunchRefused(
        own,
        state({ terminalLayoutsByTabId: { [LEGACY_TAB]: husk('pty-old-1') } })
      )
    ).toBe(false)
    // Unattributed (no husk, no catalog owner, no owner in the id): never refused here either.
    expect(isMirrorRecordRelaunchRefused(own, state())).toBe(false)
  })

  it('refuses a tab-less record whose id, catalog or husk PTY names another owner', () => {
    expect(isMirrorRecordRelaunchRefused(record(LEGACY_TAB, PAIRED_WT), state())).toBe(true)
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(MACBOOK, 'host-tab')
    expect(isMirrorRecordRelaunchRefused(record(qualified, LOCAL_WT), state())).toBe(true)
    expect(
      isMirrorRecordRelaunchRefused(
        record(LEGACY_TAB, LOCAL_WT),
        state({ terminalLayoutsByTabId: { [LEGACY_TAB]: husk(`remote:${MACBOOK}@@term-1`) } })
      )
    ).toBe(true)
  })

  it("lets another owner's pane relaunch only while the mirror lists it, and says why not", () => {
    const listed = state({
      tabsByWorktree: { [PAIRED_WT]: [tab(LEGACY_TAB, PAIRED_WT)] },
      terminalLayoutsByTabId: { [LEGACY_TAB]: husk(`remote:${MACBOOK}@@term-1`) }
    })
    const mirrorRecord = record(LEGACY_TAB, PAIRED_WT)
    expect(isMirrorRecordRelaunchRefused(mirrorRecord, listed)).toBe(false)

    const unverified = state({
      ...listed,
      tabsByWorktree: {
        [PAIRED_WT]: [tab(LEGACY_TAB, PAIRED_WT, { mirrorAbsenceUnverified: true })]
      }
    })
    expect(isMirrorRecordRelaunchRefused(mirrorRecord, unverified)).toBe(true)
    expect(mirrorRecordRelaunchRefusalReason(mirrorRecord, unverified)).toBe('unverified')
    expect(mirrorRecordRelaunchRefusalReason(mirrorRecord, state())).toBe('not-listed')
  })

  it('ignores SSH records and panes that are not web-terminal ids', () => {
    expect(
      isMirrorRecordRelaunchRefused(
        { ...record(LEGACY_TAB, PAIRED_WT), connectionId: 'ssh-target-1' },
        state()
      )
    ).toBe(false)
    expect(isMirrorRecordRelaunchRefused(record('local-tab', PAIRED_WT), state())).toBe(false)
  })
})

// Session parity, step 7: the launch guard refuses any record held under a workspace this computer
// does not own (peer or unresolved provenance), whatever its pane id; direct SSH keeps its resume.
describe('the launch guard for records under a workspace another computer owns (step 7)', () => {
  const SSH_WT = 'ssh-repo::/home/sal/project'
  const MIXED_WT = 'mixed-repo::/Users/maintainer/shared'
  const CLIENT_MINTED = '5a0f3f4e-2b1c-4d7e-9f80-1a2b3c4d5e6f'
  const catalog = state({
    repos: [
      { id: 'paired-repo', executionHostId: `runtime:${MACBOOK}` },
      { id: 'local-repo', executionHostId: 'local' },
      { id: 'ssh-repo', executionHostId: 'ssh:build-box' },
      // Why two records under one id: one names a paired runtime, one this computer (unresolved).
      { id: 'mixed-repo', executionHostId: `runtime:${MACBOOK}` },
      { id: 'mixed-repo', executionHostId: 'local' }
    ] as unknown as Repo[]
  })

  afterEach(() => useAppStore.setState(initialStoreState, true))

  it('refuses peer and unresolved workspaces whatever the pane id', () => {
    for (const tabId of [CLIENT_MINTED, LEGACY_TAB]) {
      expect(isNonOwnedWorkspaceRecordLaunchRefused(record(tabId, PAIRED_WT), catalog)).toBe(true)
      expect(isNonOwnedWorkspaceRecordLaunchRefused(record(tabId, MIXED_WT), catalog)).toBe(true)
    }
  })

  it("keeps this computer's own and direct-SSH workspaces launchable (F10)", () => {
    expect(isNonOwnedWorkspaceRecordLaunchRefused(record(CLIENT_MINTED, LOCAL_WT), catalog)).toBe(
      false
    )
    expect(isNonOwnedWorkspaceRecordLaunchRefused(record(CLIENT_MINTED, SSH_WT), catalog)).toBe(
      false
    )
  })

  it('makes launchSleepingAgentSession open no tab for a plain-UUID capture of a peer workspace', () => {
    const capture = record(CLIENT_MINTED, PAIRED_WT)
    useAppStore.setState({
      repos: catalog.repos,
      tabsByWorktree: { [PAIRED_WT]: [] },
      sleepingAgentSessionsByPaneKey: { [capture.paneKey]: capture }
    } as never)

    expect(launchSleepingAgentSession(capture)).toBe(false)
    expect(useAppStore.getState().tabsByWorktree[PAIRED_WT]).toEqual([])
    // Why kept: the owner's ledger vouches for or retires it; a refused launch drops nothing.
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[capture.paneKey]).toEqual(capture)
  })
})
