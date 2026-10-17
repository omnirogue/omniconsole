import type { SessionContextAttachment } from '../../shared/session-context-attachments'
import type { SessionProjectForPane } from '../../shared/session-project-cli'
import type { ProjectLaunchRuntime } from './project-launch-resolve'

type FolderRelay = Pick<ProjectLaunchRuntime, 'requestSessionFolders'>

export const PROJECT_FOR_PANE_OLDER_WINDOW =
  'Finding a terminal’s project requires an updated OmniConsole window. Reload the app and try again.'

/** The project folder a pane works in, as its project page counts threads; null when in none. */
export async function readProjectForPane(
  runtime: FolderRelay,
  paneKey: string
): Promise<string | null> {
  const answer = await runtime.requestSessionFolders({ kind: 'projectForPane', paneKey })
  // Why the key check: an older window answers a kind it doesn't know with nothing.
  if (!answer || typeof answer !== 'object' || !('folderId' in answer)) {
    throw new Error(PROJECT_FOR_PANE_OLDER_WINDOW)
  }
  const { folderId } = answer as SessionProjectForPane
  return typeof folderId === 'string' && folderId ? folderId : null
}

/**
 * Keeps a launch's project context on the tab main started, as the launcher does, so a restart
 * re-delivers it and the info panel shows it. False when the window could not keep it.
 */
export async function bindProjectLaunchContext(
  runtime: FolderRelay,
  args: { tabId: string; worktreeId: string | null; items: SessionContextAttachment[] }
): Promise<boolean> {
  if (!args.items.length) {
    return true
  }
  const answer = await runtime
    .requestSessionFolders({ kind: 'bindLaunchContext', ...args })
    .catch(() => null)
  // Why: an older window answers a kind it doesn't know with nothing; the launch stands anyway.
  return !!answer && typeof answer === 'object' && 'bound' in answer
}
