import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { persistedTerminalTab } from './workspace-terminal-tab-persistence'

const LEAF = '11111111-1111-4111-8111-111111111111'

function mirrorTab(): TerminalTab {
  return {
    id: 'web-terminal-studio-tab',
    worktreeId: 'folder:studio-folder',
    ptyId: null,
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    aiVaultTitle: { agent: 'claude', sessionId: 'session-1', title: 'Stale local name' },
    mirrorAbsenceUnverified: true,
    runtimeOwnerTabId: 'studio-tab',
    runtimeOwnerArchiveByLeafId: {},
    runtimeOwnerTitleByLeafId: { [LEAF]: 'Decision centralization system' }
  }
}

describe('persistedTerminalTab', () => {
  it("keeps the paired owner's session name across a restart and drops receiver evidence", () => {
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: { 'folder:studio-folder': [persistedTerminalTab(mirrorTab())] },
      terminalLayoutsByTabId: {}
    })

    expect(parsed.ok).toBe(true)
    const restored = parsed.ok ? parsed.value.tabsByWorktree['folder:studio-folder']?.[0] : null
    // Why: without it, the stale local aiVaultTitle named the owner's session until a frame landed.
    expect(restored?.runtimeOwnerTitleByLeafId).toEqual({
      [LEAF]: 'Decision centralization system'
    })
    expect(restored).not.toHaveProperty('runtimeOwnerTabId')
    expect(restored).not.toHaveProperty('runtimeOwnerArchiveByLeafId')
    expect(restored).not.toHaveProperty('mirrorAbsenceUnverified')
  })
})
