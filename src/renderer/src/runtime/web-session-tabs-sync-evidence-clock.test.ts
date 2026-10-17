import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus
} from '../../../shared/agent-status-freshness'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

function snapshot(hostTime: number, version: number, observation = hostTime) {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'codex [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'check',
          updatedAt: hostTime,
          evidenceObservedAt: observation,
          stateStartedAt: hostTime,
          agentType: 'codex',
          paneKey: makePaneKey('host-tab-1', LEAF_ID),
          tabId: 'host-tab-1',
          worktreeId: WT,
          stateHistory: []
        }
      }
    ],
    { snapshotVersion: version }
  )
}

describe('mirrored runtime evidence clocks', () => {
  beforeEach(resetWebSessionTabsSyncTestState)
  it.each([-86_400_000, 86_400_000])('ages on the receiving clock with host skew %s', (skew) => {
    const initial = makeState()
    const first = applyWebSessionTabsSnapshot(initial, snapshot(NOW + skew, 1), ENV, NOW)
    const state = { ...initial, ...first }
    const [paneKey, entry] = Object.entries(state.agentStatusByPaneKey)[0]
    expect(entry.mirroredEvidenceReceivedAt).toBe(NOW)
    const later = NOW + AGENT_STATUS_STALE_AFTER_MS + 1
    const replay = applyWebSessionTabsSnapshot(
      state,
      snapshot(NOW + skew + 1, 2, NOW + skew),
      ENV,
      later
    )
    const retained = { ...state, ...replay }.agentStatusByPaneKey[paneKey]
    expect(retained.mirroredEvidenceReceivedAt).toBe(NOW)
    expect(isFreshNonDoneAgentStatus(retained, later)).toBe(false)
    const fresh = applyWebSessionTabsSnapshot(
      { ...state, ...replay },
      snapshot(NOW + skew + 2, 3),
      ENV,
      later
    )
    expect(fresh?.agentStatusByPaneKey?.[paneKey].mirroredEvidenceReceivedAt).toBe(later)
    expect(isFreshNonDoneAgentStatus(fresh?.agentStatusByPaneKey?.[paneKey], later)).toBe(true)
  })
})
