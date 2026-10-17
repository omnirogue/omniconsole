import { translate } from '@/i18n/i18n'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { resolveNativeChatFileLinkContext } from '../native-chat/native-chat-file-link'
import {
  getTerminalFileContext,
  openDetectedFilePath
} from '../terminal-pane/terminal-file-open-routing'
import { workspaceLocation } from './discover-run-text'

export type WorkflowLocationOutcome = 'opened' | 'unavailable' | 'outside' | 'missing' | 'folder'

/**
 * Opens a "path:line" an agent reported in the editor. The path must stay inside this workspace
 * and name an existing file: folders are refused (on macOS an .app bundle is a folder), and the
 * check runs before the shared file routing, which would otherwise authorize the path.
 */
export async function openLocalWorkflowLocation(
  conversationTabId: string,
  location: string
): Promise<WorkflowLocationOutcome> {
  const context = resolveNativeChatFileLinkContext(useAppStore.getState(), conversationTabId)
  if (!context) {
    return 'unavailable'
  }
  const target = workspaceLocation(location, context.worktreePath)
  if (!target) {
    return 'outside'
  }
  const absolutePath = `${context.worktreePath.replace(/[\\/]+$/, '')}/${target.relativePath}`
  const fileContext = getTerminalFileContext(
    context.worktreeId,
    context.worktreePath,
    context.runtimeEnvironmentId
  )
  try {
    if ((await statRuntimePath(fileContext, absolutePath)).isDirectory) {
      return 'folder'
    }
  } catch {
    // Missing, unreadable, or a link that resolves outside the workspace.
    return 'missing'
  }
  openDetectedFilePath(absolutePath, target.line, null, {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId
  })
  return 'opened'
}

/** What to tell the person when a location did not open. */
export function workflowLocationProblem(
  outcome: WorkflowLocationOutcome,
  location: string
): string | undefined {
  switch (outcome) {
    case 'opened':
      return undefined
    case 'unavailable':
      return translate(
        'localWorkflow.run.cannotOpenLocation',
        "{{location}} can't be opened from this workspace.",
        { location }
      )
    case 'outside':
      return translate(
        'localWorkflow.run.locationOutside',
        "{{location}} is outside this workspace, so it wasn't opened.",
        { location }
      )
    case 'missing':
      return translate('localWorkflow.run.locationMissing', "{{location}} doesn't exist here.", {
        location
      })
    case 'folder':
      return translate(
        'localWorkflow.run.locationFolder',
        '{{location}} is a folder, not a file.',
        { location }
      )
  }
}
