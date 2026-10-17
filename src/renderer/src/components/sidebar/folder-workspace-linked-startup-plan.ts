import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import {
  buildHubTaskEnvironment,
  prependHubTaskPrompt
} from '../../../../shared/omnios-task-binding'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  withAgentTemplateInstructions,
  type AgentTemplateText
} from '../../../../shared/agent-template-dispatch'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'

/**
 * The launch context a linked folder-workspace agent starts with in its TUI
 * input but never submits — delivered as argv prefill or a startup paste
 * depending on the agent.
 */
export function resolveFolderWorkspaceLaunchDraft(
  linkedWorkItem: LinkedWorkItemSummary,
  note: string,
  /** Follows the fully assembled draft, once. */
  agentTemplate: AgentTemplateText | null = null
): string | null {
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(linkedWorkItem, note)
  const draft = (draftPrompt ?? prompt.trim()) || null
  const assembled = draft ? prependHubTaskPrompt(draft, linkedWorkItem.hubTaskId) : ''
  return withAgentTemplateInstructions(assembled, agentTemplate) || null
}

export function buildFolderWorkspaceLinkedStartupPlan(args: {
  agent: TuiAgent
  linkedWorkItem: LinkedWorkItemSummary
  note: string
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  submitPrompt?: boolean
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
  agentTemplate?: AgentTemplateText | null
}): AgentStartupPlan | null {
  const linkedDraftPrompt = resolveFolderWorkspaceLaunchDraft(
    args.linkedWorkItem,
    args.note,
    args.agentTemplate ?? null
  )
  const agentEnv = args.linkedWorkItem.hubTaskId
    ? { ...args.agentEnv, ...buildHubTaskEnvironment(args.linkedWorkItem.hubTaskId) }
    : args.agentEnv
  const draftLaunchPlan =
    linkedDraftPrompt && !args.submitPrompt
      ? buildAgentDraftLaunchPlan({
          agent: args.agent,
          draft: linkedDraftPrompt,
          cmdOverrides: args.agentCmdOverrides ?? {},
          agentArgs: args.agentArgs,
          agentEnv,
          sessionOptions: args.sessionOptions,
          sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
          platform: args.platform,
          shell: args.shell,
          isRemote: args.isRemote
        })
      : null
  if (draftLaunchPlan) {
    return {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.sessionOptions ? { sessionOptions: draftLaunchPlan.sessionOptions } : {}),
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  }

  const startupPlan = buildAgentStartupPlan({
    agent: args.agent,
    // Why: linked context must stay reviewable; launch empty, then paste the
    // draft after the agent is ready instead of submitting it on argv/stdin.
    prompt: args.submitPrompt ? (linkedDraftPrompt ?? '') : '',
    cmdOverrides: args.agentCmdOverrides ?? {},
    agentArgs: args.agentArgs,
    agentEnv,
    sessionOptions: args.sessionOptions,
    sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
    platform: args.platform,
    shell: args.shell,
    isRemote: args.isRemote,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && linkedDraftPrompt && !args.submitPrompt) {
    startupPlan.draftPrompt = linkedDraftPrompt
  }
  return startupPlan
}
