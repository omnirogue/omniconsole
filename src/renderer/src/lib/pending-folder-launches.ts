import { withProjectCoordinator, type ProjectCoordinator } from '../../../shared/project-settings'
import { launchFilingChange, applyRecordedChange } from './session-organization-app-changes'
import { setProjectSettingsByPerson } from './session-organization-person-changes'
import {
  getSessionFolderId,
  projectSettingsFor,
  type SessionFolderMetadata
} from './session-folders'
import type { SidebarSession } from './sidebar-sessions'

/** A launch that never produces a fileable row (failed, closed) stops waiting after this. */
export const PENDING_FOLDER_LAUNCH_TTL_MS = 10 * 60_000

type PendingFolderLaunch = {
  folderId: string
  at: number
  /** Set when the launch is the project's chat: its row is bound as the coordinator too. */
  coordinator?: ProjectCoordinator['launch']
}

/** Files one launched conversation; by default a recorded launch filing (prepared first). */
export type FileLaunchedSession = (sessionKey: string, folderId: string, tabId: string) => void

/** Binds one launched conversation as a project's chat; by default the person's recorded save. */
export type BindCoordinatorSession = (
  sessionKey: string,
  folderId: string,
  launch: ProjectCoordinator['launch']
) => void

/** The subset of the session-folders store filing needs. */
export type PendingFolderLaunchTarget = {
  loaded: boolean
  metadata: SessionFolderMetadata
  file?: FileLaunchedSession
  bindCoordinator?: BindCoordinatorSession
}

const fileRecorded: FileLaunchedSession = (sessionKey, folderId, tabId) => {
  void applyRecordedChange(launchFilingChange(sessionKey, folderId, tabId))
}

function bindCoordinatorRecorded(target: PendingFolderLaunchTarget): BindCoordinatorSession {
  return (sessionKey, folderId, launch) => {
    const settings = projectSettingsFor(target.metadata, folderId)
    if (settings) {
      setProjectSettingsByPerson(folderId, withProjectCoordinator(settings, { launch, sessionKey }))
    }
  }
}

/** Tab ids that are the same tab under another name (a unified tab and the entity it shows). */
export type TabAliases = (tabId: string) => readonly string[]

const pendingByTabId = new Map<string, PendingFolderLaunch>()
const listeners = new Set<() => void>()

/** Runs `listener` whenever a launch starts waiting, so a row that already exists is filed now. */
export function subscribePendingFolderLaunches(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Remembers that the conversation opening in `tabId` was started from a folder's "+". It is filed
 * there the first time its sidebar row has a session identity; nothing about the session itself
 * (workspace, files, agent) depends on the folder.
 */
export function fileLaunchInFolder(tabId: string, folderId: string, now = Date.now()): void {
  pendingByTabId.set(tabId, { ...pendingByTabId.get(tabId), folderId, at: now })
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Remembers that the conversation opening in `tabId` is the project's chat, started from its
 * page: filed in the project and, the moment its row has a session identity, recorded as
 * `ProjectSettings.coordinator` under that key (the key migration follows it to the provider key).
 */
export function bindCoordinatorLaunch(
  tabId: string,
  folderId: string,
  launch: ProjectCoordinator['launch'],
  now = Date.now()
): void {
  pendingByTabId.set(tabId, { folderId, at: now, coordinator: launch })
  for (const listener of listeners) {
    listener()
  }
}

export function hasPendingFolderLaunches(): boolean {
  return pendingByTabId.size > 0
}

export function clearPendingFolderLaunches(): void {
  pendingByTabId.clear()
}

/**
 * Files every waiting launch whose row now has a session key. A row someone already filed (for
 * example dragged elsewhere first) is left alone, and a folder deleted meanwhile files nothing.
 */
export function applyPendingFolderLaunches(
  sessions: readonly SidebarSession[],
  target: PendingFolderLaunchTarget,
  aliases: TabAliases = (tabId) => [tabId],
  now = Date.now()
): void {
  if (pendingByTabId.size === 0 || !target.loaded) {
    return
  }
  for (const [tabId, pending] of pendingByTabId) {
    if (now - pending.at > PENDING_FOLDER_LAUNCH_TTL_MS) {
      pendingByTabId.delete(tabId)
      continue
    }
    const ids = new Set(aliases(tabId))
    const session = sessions.find(
      (candidate) => candidate.tabId !== null && ids.has(candidate.tabId) && candidate.sessionKey
    )
    if (!session?.sessionKey) {
      continue
    }
    pendingByTabId.delete(tabId)
    const folderExists = target.metadata.folders.some((folder) => folder.id === pending.folderId)
    if (!folderExists) {
      continue
    }
    if (pending.coordinator) {
      const bind = target.bindCoordinator ?? bindCoordinatorRecorded(target)
      bind(session.sessionKey, pending.folderId, pending.coordinator)
    }
    if (getSessionFolderId(target.metadata, session.sessionKey) !== null) {
      continue
    }
    const file = target.file ?? fileRecorded
    file(session.sessionKey, pending.folderId, session.tabId ?? tabId)
  }
}
