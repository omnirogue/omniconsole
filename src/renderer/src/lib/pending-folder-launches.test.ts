import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'
import type { SessionFolderMetadata } from './session-folders'
import {
  PENDING_FOLDER_LAUNCH_TTL_MS,
  applyPendingFolderLaunches,
  bindCoordinatorLaunch,
  clearPendingFolderLaunches,
  fileLaunchInFolder,
  hasPendingFolderLaunches,
  subscribePendingFolderLaunches
} from './pending-folder-launches'

const FOLDER = '00000000-0000-4000-8000-000000000001'

function session(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: 'pane-key',
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

function target(metadata: Partial<SessionFolderMetadata> = {}) {
  return {
    loaded: true,
    metadata: {
      version: 1 as const,
      folders: [{ id: FOLDER, name: 'Client' }],
      membership: {},
      ...metadata
    },
    file: vi.fn(),
    bindCoordinator: vi.fn()
  }
}

afterEach(() => clearPendingFolderLaunches())

describe('applyPendingFolderLaunches', () => {
  it('binds the project chat once its row has a session key, and files it', () => {
    const store = target()
    bindCoordinatorLaunch('tab', FOLDER, { agent: 'codex', team: true }, 0)
    applyPendingFolderLaunches([session({ sessionKey: null })], store, undefined, 1)
    expect(store.bindCoordinator).not.toHaveBeenCalled()

    applyPendingFolderLaunches([session({})], store, undefined, 2)
    expect(store.bindCoordinator).toHaveBeenCalledWith('pane-key', FOLDER, {
      agent: 'codex',
      team: true
    })
    expect(store.file).toHaveBeenCalledWith('pane-key', FOLDER, 'tab')
    expect(hasPendingFolderLaunches()).toBe(false)
  })

  it('binds the project chat even when its row was filed elsewhere first', () => {
    const store = target({ membership: { 'pane-key': 'saved-sessions' } })
    bindCoordinatorLaunch('tab', FOLDER, { agent: 'claude' }, 0)
    applyPendingFolderLaunches([session({})], store, undefined, 1)
    expect(store.bindCoordinator).toHaveBeenCalledWith('pane-key', FOLDER, { agent: 'claude' })
    expect(store.file).not.toHaveBeenCalled()
  })

  it('files a plain launch without binding it', () => {
    const store = target()
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([session({})], store, undefined, 1)
    expect(store.bindCoordinator).not.toHaveBeenCalled()
    expect(store.file).toHaveBeenCalledTimes(1)
  })

  it('files the launched conversation once its row has a session key', () => {
    const store = target()
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([session({ sessionKey: null })], store, undefined, 1)
    expect(store.file).not.toHaveBeenCalled()
    expect(hasPendingFolderLaunches()).toBe(true)

    applyPendingFolderLaunches([session({})], store, undefined, 2)
    expect(store.file).toHaveBeenCalledWith('pane-key', FOLDER, expect.any(String))
    expect(hasPendingFolderLaunches()).toBe(false)
  })

  it('matches the row through a tab alias (unified tab vs. its entity)', () => {
    const store = target()
    fileLaunchInFolder('unified-tab', FOLDER, 0)
    applyPendingFolderLaunches(
      [session({ tabId: 'entity-tab' })],
      store,
      (id) => [id, 'entity-tab'],
      1
    )
    expect(store.file).toHaveBeenCalledWith('pane-key', FOLDER, expect.any(String))
  })

  it('leaves a conversation that was already filed somewhere else', () => {
    const store = target({ membership: { 'pane-key': 'saved-sessions' } })
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([session({})], store, undefined, 1)
    expect(store.file).not.toHaveBeenCalled()
    expect(hasPendingFolderLaunches()).toBe(false)
  })

  it('files nothing when the folder was deleted meanwhile', () => {
    const store = target({ folders: [] })
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([session({})], store, undefined, 1)
    expect(store.file).not.toHaveBeenCalled()
    expect(hasPendingFolderLaunches()).toBe(false)
  })

  it('stops waiting for a launch that never produced a row', () => {
    const store = target()
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([], store, undefined, PENDING_FOLDER_LAUNCH_TTL_MS + 1)
    expect(hasPendingFolderLaunches()).toBe(false)
    applyPendingFolderLaunches([session({})], store, undefined, PENDING_FOLDER_LAUNCH_TTL_MS + 2)
    expect(store.file).not.toHaveBeenCalled()
  })

  it('waits until folders are loaded', () => {
    const store = { ...target(), loaded: false }
    fileLaunchInFolder('tab', FOLDER, 0)
    applyPendingFolderLaunches([session({})], store, undefined, 1)
    expect(store.file).not.toHaveBeenCalled()
    expect(hasPendingFolderLaunches()).toBe(true)
  })

  it('tells subscribers when a launch starts waiting', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePendingFolderLaunches(listener)
    fileLaunchInFolder('tab', FOLDER, 0)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    fileLaunchInFolder('tab-2', FOLDER, 0)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
