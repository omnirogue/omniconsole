import { describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'
import { applySessionFolderKeyMigrations } from './session-folder-key-migration'

function session(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: 'provider-key',
    worktreeId: 'wt',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Session',
    workspaceLabel: 'Workspace',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

describe('applySessionFolderKeyMigrations', () => {
  it('calls migrateSessionKey for every row carrying a pending migration', () => {
    const migrateSessionKey = vi.fn().mockReturnValue(true)
    applySessionFolderKeyMigrations(
      [
        session({ folderKeyMigration: { from: 'provisional-a', to: 'provider-a' } }),
        session({ rowKey: 'row-2', folderKeyMigration: null }),
        session({
          rowKey: 'row-3',
          folderKeyMigration: { from: 'provisional-b', to: 'provider-b' }
        })
      ],
      { migrateSessionKey }
    )
    expect(migrateSessionKey).toHaveBeenCalledTimes(2)
    expect(migrateSessionKey).toHaveBeenCalledWith('provisional-a', 'provider-a')
    expect(migrateSessionKey).toHaveBeenCalledWith('provisional-b', 'provider-b')
  })

  it('does nothing when no row has a pending migration', () => {
    const migrateSessionKey = vi.fn()
    applySessionFolderKeyMigrations([session({})], { migrateSessionKey })
    expect(migrateSessionKey).not.toHaveBeenCalled()
  })
})
