import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resetDeferredStartupMountStateForTests } from '@/components/terminal/deferred-startup-mount'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import {
  keepResumeCheckpoint,
  launchedTabPaneKey,
  setAsideResumeCheckpoint
} from './resume-checkpoint-hold'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  resetDeferredStartupMountStateForTests()
  useAppStore.setState(initialAppStoreState, true)
})

const record: SleepingAgentSessionRecord = {
  paneKey: 'old-tab:leaf-1',
  tabId: 'old-tab',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'sess-1' },
  prompt: 'finish the task',
  state: 'working',
  origin: 'worktree-sleep',
  restoreOnTabOpenOnly: true,
  ownerSleepPtyIncarnationId: 'pty-old',
  capturedAt: 1,
  updatedAt: 1
}

const records = () => useAppStore.getState().sleepingAgentSessionsByPaneKey
const tabs = () => useAppStore.getState().tabsByWorktree['wt-1'] ?? []

/** What the window's `resumeSession` with `keepCheckpoint` does: launch, then set it aside. */
function restartWithCheckpointSetAside(): { tabId: string; paneKey: string } {
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }] },
    activeWorktreeId: 'wt-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
  let tabId = null as string | null
  expect(
    launchSleepingAgentSession(record, {
      suppressNavigation: true,
      onSessionLaunched: (id) => {
        tabId = id
      }
    })
  ).toBe(true)
  setAsideResumeCheckpoint(tabId!, record)
  return { tabId: tabId!, paneKey: launchedTabPaneKey(tabId)! }
}

describe('a session restart keeps its checkpoint until the agent confirms it', () => {
  it('leaves the new pane without a record while it starts, so it spawns as a fresh tab', () => {
    const { tabId, paneKey } = restartWithCheckpointSetAside()
    expect(paneKey).toMatch(new RegExp(`^${tabId}:`))
    expect(records()).toEqual({})
  })

  it('gives an unconfirmed restart the checkpoint back on the new pane, never the old one', () => {
    const { tabId, paneKey } = restartWithCheckpointSetAside()

    expect(keepResumeCheckpoint(tabId, 'launched')).toEqual({ kept: true })

    expect(Object.keys(records())).toEqual([paneKey])
    const kept = records()[paneKey]
    expect(kept).toMatchObject({
      paneKey,
      tabId,
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      origin: 'live'
    })
    expect(kept).not.toHaveProperty('restoreOnTabOpenOnly')
    expect(kept).not.toHaveProperty('ownerSleepPtyIncarnationId')
    expect(keepResumeCheckpoint(tabId, 'launched')).toEqual({ kept: false })
  })

  it('puts the checkpoint back on its old pane when the new pane does not hold the conversation', () => {
    const { tabId } = restartWithCheckpointSetAside()

    expect(keepResumeCheckpoint(tabId, 'original')).toEqual({ kept: true })

    expect(records()).toEqual({ [record.paneKey]: record })
  })

  it('never puts it back over a record the old pane holds again', () => {
    const { tabId } = restartWithCheckpointSetAside()
    const newer = { ...record, capturedAt: 5 }
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: newer } })

    expect(keepResumeCheckpoint(tabId, 'original')).toEqual({ kept: false })
    expect(records()[record.paneKey]).toBe(newer)
  })

  it('never replaces a record the new pane’s agent already wrote', () => {
    const { tabId, paneKey } = restartWithCheckpointSetAside()
    const live = { ...record, paneKey, tabId, origin: 'live' as const, capturedAt: 9 }
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [paneKey]: live } })

    expect(keepResumeCheckpoint(tabId, 'launched')).toEqual({ kept: false })
    expect(records()[paneKey]).toBe(live)
  })

  it('never lets a worktree activation start a second copy beside the new tab’s terminal', () => {
    const { tabId } = restartWithCheckpointSetAside()
    // Main keeps it only after the 30 s wait: the tab's terminal runs and its launch claim is gone.
    useAppStore.setState({
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {},
      ptyIdsByTabId: { [tabId]: ['pty-new'] }
    })
    keepResumeCheckpoint(tabId, 'launched')
    resumeSleepingAgentSessionsForWorktree('wt-1')
    expect(tabs()).toHaveLength(1)
  })
})
