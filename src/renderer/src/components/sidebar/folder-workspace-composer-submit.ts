import {
  chatBypassLaunchArgs,
  chatBypassLaunchEnv
} from '../../../../shared/chat-launch-permissions'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-linked-startup-plan'

export {
  buildFolderWorkspaceLinkedStartupPlan,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-linked-startup-plan'

import { CLIENT_PLATFORM, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { launchFolderWorkspaceAgentSession } from '@/lib/folder-workspace-agent-launch'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import {
  withAgentTemplateInstructions,
  type AgentTemplateText
} from '../../../../shared/agent-template-dispatch'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
  /** Set when the caller already knows the folder (the Companies flow); the sidebar composer lets main derive it. */
  folderPath?: string | null
  connectionId?: string | null
  linkedTask: FolderWorkspace['linkedTask']
  linkedTaskSourceContext?: TaskSourceContext | null
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
}

type SubmitFolderWorkspaceCreateParams = {
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  linkedTaskSourceContext?: TaskSourceContext | null
  note: string
  quickAgent: TuiAgent | null
  /** Follows the assembled first message or draft, once; the plain text when nothing was typed. */
  agentTemplate?: AgentTemplateText | null
  autoRenameBranchFromWork: boolean | undefined
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  submitPrompt?: boolean
  chatBypass?: boolean
  terminalWindowsShell?: string | null
  isRemote?: boolean
  launchSource?: LaunchSource
  runtimeEnvironmentId?: string | null
  createFolderWorkspace: (input: FolderWorkspaceCreateInput) => Promise<FolderWorkspace | null>
  onLaunched?: (worktreeId: string, tabId: string) => void
  onOpenChange: (open: boolean) => void
}

export function getFolderWorkspaceAgentLaunchPlatform(
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'parentPath'>
): NodeJS.Platform {
  const parentPath = projectGroup.parentPath?.trim() ?? ''
  if (projectGroup.connectionId) {
    return isWindowsAbsolutePathLike(parentPath) ? 'win32' : 'linux'
  }
  return parentPath && isWslUncPath(parentPath) ? 'linux' : CLIENT_PLATFORM
}

export async function submitFolderWorkspaceCreate({
  projectGroup,
  name,
  lastAutoName,
  linkedWorkItem,
  linkedTaskSourceContext,
  note,
  quickAgent,
  agentTemplate = null,
  autoRenameBranchFromWork,
  agentCmdOverrides,
  agentArgs,
  agentEnv,
  sessionOptions,
  sessionOptionsOverrideAgentArgs,
  submitPrompt,
  chatBypass,
  terminalWindowsShell,
  launchSource = 'sidebar',
  runtimeEnvironmentId = null,
  createFolderWorkspace,
  onOpenChange,
  onLaunched
}: SubmitFolderWorkspaceCreateParams): Promise<boolean> {
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = !name.trim() || name === lastAutoName || isWorkItemLookupText(name)
  const workspaceName =
    nameIsAutoManaged && linkedName
      ? linkedName
      : name.trim() || linkedName || `${projectGroup.name} workspace`
  const launchPlatform = getFolderWorkspaceAgentLaunchPlatform(projectGroup)
  // Why: an SSH folder group runs the plain `omni` relay shim, so the Linux-only
  // `omni-ide` rename must not be applied for remote launches.
  const launchIsRemote = Boolean(projectGroup.connectionId)
  const launchShell = resolveLocalWindowsAgentStartupShell({
    platform: launchPlatform,
    isRemote: launchIsRemote,
    terminalWindowsShell
  })
  if (chatBypass && quickAgent) {
    agentArgs = chatBypassLaunchArgs(quickAgent, agentArgs, launchShell ?? 'posix')
    agentEnv = chatBypassLaunchEnv(quickAgent, agentEnv ?? {})
  }
  const startupPlan =
    quickAgent && linkedWorkItem
      ? buildFolderWorkspaceLinkedStartupPlan({
          agent: quickAgent,
          linkedWorkItem,
          note,
          agentCmdOverrides,
          agentArgs,
          agentEnv,
          sessionOptions,
          sessionOptionsOverrideAgentArgs,
          submitPrompt,
          platform: launchPlatform,
          shell: launchShell,
          isRemote: launchIsRemote,
          agentTemplate
        })
      : quickAgent
        ? buildAgentStartupPlan({
            agent: quickAgent,
            prompt: withAgentTemplateInstructions(note, agentTemplate),
            cmdOverrides: agentCmdOverrides ?? {},
            agentArgs,
            agentEnv,
            sessionOptions,
            sessionOptionsOverrideAgentArgs,
            platform: launchPlatform,
            shell: launchShell,
            isRemote: launchIsRemote,
            allowEmptyPromptLaunch: true
          })
        : null
  // Why: the argv-prefill plan carries the draft inside `launchCommand`, so
  // `startupPlan.draftPrompt` alone can't tell whether this launch has one.
  const launchDraftPrompt =
    quickAgent && linkedWorkItem && !submitPrompt
      ? resolveFolderWorkspaceLaunchDraft(linkedWorkItem, note, agentTemplate)
      : null
  // Why: the pending badge should only appear when the submitted prompt can
  // actually produce the first agent message that names the workspace.
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true &&
    !name.trim() &&
    !linkedWorkItem &&
    Boolean(quickAgent) &&
    note.trim().length > 0

  const workspace = await createFolderWorkspace({
    projectGroupId: projectGroup.id,
    name: workspaceName,
    // Why: SSH folder groups must keep their target provenance even when the
    // focused runtime is local or another host.
    connectionId: projectGroup.connectionId ?? null,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(linkedTaskSourceContext ? { linkedTaskSourceContext } : {}),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!workspace) {
    return false
  }
  await launchFolderWorkspaceAgentSession({
    workspace,
    agent: quickAgent,
    startupPlan,
    launchDraftPrompt,
    launchSource,
    runtimeEnvironmentId,
    fallbackConnectionId: projectGroup.connectionId,
    onLaunched,
    beforeActivate: () => onOpenChange(false)
  })
  return true
}
