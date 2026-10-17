import type { SidebarSessionSource } from '@/lib/sidebar-sessions'
import type { ConsoleJiraWorkRef } from '../../../shared/console-jira-work-contract'

export type SessionFoldersE2E = {
  /** Files the sessions shown for these pane keys in the named folder, as a person's move would. */
  moveSessionsToFolder: (paneKeys: readonly string[], folderName: string) => Promise<boolean>
  /** Records the session shown for this pane key as the named project's chat, as a start would. */
  bindProjectChat: (paneKey: string, folderName: string) => Promise<boolean>
  /** Saves the named folder's project Jira issues, as the page's picker would. */
  setProjectTasks: (folderName: string, tasks: readonly ConsoleJiraWorkRef[]) => Promise<boolean>
}

/**
 * E2E-only handle on the session folder store. Why: filing a session needs a drag in the UI, and
 * the store is per profile and not on `window.__store`.
 */
export function installSessionFoldersE2E(target: Record<string, unknown>): void {
  const handle: SessionFoldersE2E = {
    moveSessionsToFolder: async (paneKeys, folderName) => {
      // Why dynamic: these modules reach back into the app store, so a static import would cycle.
      const [
        { useSessionFolders },
        { buildPaneSessions },
        { moveSessionsByPerson },
        { useAppStore }
      ] = await Promise.all([
        import('./session-folders'),
        import('@/lib/sidebar-sessions'),
        import('@/lib/session-organization-person-changes'),
        import('./index')
      ])
      const folder = useSessionFolders
        .getState()
        .metadata.folders.find((entry) => entry.name === folderName)
      if (!folder) {
        return false
      }
      const keys = buildPaneSessions(useAppStore.getState() as unknown as SidebarSessionSource)
        .filter((session) => session.paneKey && paneKeys.includes(session.paneKey))
        .map((session) => session.sessionKey ?? session.rowKey)
      return (
        keys.length === paneKeys.length && moveSessionsByPerson(keys, folder.id, { via: 'sidebar' })
      )
    },
    bindProjectChat: async (paneKey, folderName) => {
      const [
        { useSessionFolders },
        { projectSettingsFor },
        { buildPaneSessions },
        { setProjectSettingsByPerson },
        { useAppStore },
        { emptyProjectSettings, withProjectCoordinator }
      ] = await Promise.all([
        import('./session-folders'),
        import('@/lib/session-folders'),
        import('@/lib/sidebar-sessions'),
        import('@/lib/session-organization-person-changes'),
        import('./index'),
        import('../../../shared/project-settings')
      ])
      const metadata = useSessionFolders.getState().metadata
      const folder = metadata.folders.find((entry) => entry.name === folderName)
      const session = buildPaneSessions(
        useAppStore.getState() as unknown as SidebarSessionSource
      ).find((entry) => entry.paneKey === paneKey)
      if (!folder || !session) {
        return false
      }
      const settings = projectSettingsFor(metadata, folder.id) ?? emptyProjectSettings(Date.now())
      return setProjectSettingsByPerson(
        folder.id,
        withProjectCoordinator(settings, {
          launch: { agent: 'codex' },
          sessionKey: session.sessionKey ?? session.rowKey
        }),
        { via: 'sidebar' }
      )
    },
    setProjectTasks: async (folderName, tasks) => {
      const [
        { useSessionFolders },
        { projectSettingsFor },
        { setProjectSettingsByPerson },
        { emptyProjectSettings }
      ] = await Promise.all([
        import('./session-folders'),
        import('@/lib/session-folders'),
        import('@/lib/session-organization-person-changes'),
        import('../../../shared/project-settings')
      ])
      const metadata = useSessionFolders.getState().metadata
      const folder = metadata.folders.find((entry) => entry.name === folderName)
      if (!folder) {
        return false
      }
      const settings = projectSettingsFor(metadata, folder.id) ?? emptyProjectSettings(Date.now())
      return setProjectSettingsByPerson(folder.id, { ...settings, tasks: [...tasks] })
    }
  }
  target.__sessionFoldersE2E = handle
}
