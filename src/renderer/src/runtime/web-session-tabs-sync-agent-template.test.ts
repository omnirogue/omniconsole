import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
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

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const agentTemplate = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }
const PTY = 'remote:web-env-1@@terminal-1'

function hostSurface(title: string) {
  return makeSnapshot([
    {
      type: 'terminal',
      id: HOST_SURFACE_ID,
      title,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      isActive: true,
      status: 'ready',
      terminal: 'terminal-1'
    }
  ])
}

function tab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: PTY,
    worktreeId: WT,
    title: 'shell',
    defaultTitle: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW - 1,
    ...extra
  }
}

describe('mirrored terminal tabs keep the launch record', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('takes it over from the local tab the host surface retires', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [tab('local-web-tab', { agentTemplate })] },
        ptyIdsByTabId: { 'local-web-tab': [PTY] },
        terminalLayoutsByTabId: {
          'local-web-tab': { root: null, activeLeafId: null, expandedLeafId: null }
        }
      }),
      hostSurface('host shell'),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const tabs = patch.tabsByWorktree?.[WT] ?? []
    expect(tabs.map((entry) => entry.id)).not.toContain('local-web-tab')
    expect(tabs[0]?.agentTemplate).toEqual(agentTemplate)
  })

  it('keeps it when a later snapshot rebuilds the mirrored tab', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [tab(mirroredId, { agentTemplate })] },
        ptyIdsByTabId: { [mirroredId]: [PTY] }
      }),
      hostSurface('renamed by the agent'),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      title: 'renamed by the agent',
      agentTemplate
    })
  })
})
