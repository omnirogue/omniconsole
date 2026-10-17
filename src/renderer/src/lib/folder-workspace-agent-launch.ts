import { useAppStore } from '@/store'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

export async function preflightFolderWorkspaceAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string | null
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight || !args.workspacePath) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
}

/**
 * The one way a freshly created folder workspace becomes a visible agent session:
 * trust preflight, startup payload, reveal, and the chat/terminal follow-ups.
 * The sidebar composer and the Companies "Start session" control both come here
 * so there is a single launch path.
 */
export async function launchFolderWorkspaceAgentSession(args: {
  workspace: Pick<FolderWorkspace, 'id' | 'folderPath' | 'connectionId'>
  agent: TuiAgent | null
  startupPlan: AgentStartupPlan | null
  launchDraftPrompt?: string | null
  launchSource: LaunchSource
  runtimeEnvironmentId?: string | null
  fallbackConnectionId?: string | null
  viewModePreference?: 'chat' | 'terminal'
  /** Runs after the startup payload is built, before the reveal (closes the composer). */
  onLaunched?: (worktreeId: string, tabId: string) => void
  beforeActivate?: () => void
}): Promise<boolean> {
  const { workspace, agent, startupPlan } = args
  const launchDraftPrompt = args.launchDraftPrompt ?? null
  await preflightFolderWorkspaceAgentTrust({
    agent,
    workspacePath: workspace.folderPath,
    connectionId: workspace.connectionId ?? args.fallbackConnectionId
  })
  if (startupPlan && !startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves share one renderer-session token.
    startupPlan.launchToken = createBrowserUuid()
  }
  const startup =
    agent && startupPlan
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
          launchAgent: agent,
          ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
          ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
          // Why: view-mode only. The argv-prefill plan sets no draftPrompt, so
          // without this the tab opens in chat with nothing mirrored into it.
          ...(launchDraftPrompt ? { launchDraftText: launchDraftPrompt } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          telemetry: {
            agent_kind: tuiAgentToAgentKind(agent),
            launch_source: args.launchSource,
            request_kind: 'new' as const
          }
        }
      : undefined
  args.beforeActivate?.()
  try {
    const previousTabs =
      useAppStore.getState().unifiedTabsByWorktree[folderWorkspaceKey(workspace.id)] ?? []
    const activation = activateAndRevealFolderWorkspace(workspace.id, {
      ...(startup ? { startup } : {}),
      runtimeEnvironmentId: args.runtimeEnvironmentId ?? null
    })
    if (
      activation !== false &&
      activation.primaryTabId &&
      args.viewModePreference &&
      !previousTabs.some(
        (tab) => tab.id === activation.primaryTabId || tab.entityId === activation.primaryTabId
      )
    ) {
      useAppStore.getState().setTabViewMode(activation.primaryTabId, args.viewModePreference)
    }
    if (
      agent &&
      startupPlan &&
      launchDraftPrompt &&
      activation !== false &&
      activation.primaryTabId
    ) {
      // Why: draft launch context reaches only the TUI input; seed the
      // chat-composer copy so it isn't invisible in the chat view.
      seedNativeChatLaunchDraftForAgentTab({
        tabId: activation.primaryTabId,
        agent,
        text: launchDraftPrompt
      })
    }
    if (
      startupPlan &&
      (startupPlan.followupPrompt || startupPlan.draftPrompt) &&
      activation !== false
    ) {
      void ensureAgentStartupInTerminal({
        worktreeId: folderWorkspaceKey(workspace.id),
        primaryTabId: activation.primaryTabId,
        startup: startupPlan
      })
    }
    if (activation !== false && activation.primaryTabId) {
      args.onLaunched?.(folderWorkspaceKey(workspace.id), activation.primaryTabId)
    }
    return activation !== false
  } catch (error) {
    // Why: creation already succeeded. Do not leave the caller stuck if the
    // follow-up reveal/startup path hits a transient issue — but say it failed.
    console.error('Failed to activate folder workspace after create:', error)
    return false
  }
}
