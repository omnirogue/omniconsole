import { resolveChatLaunchDefaults } from '../../../../shared/chat-launch-permissions'
import { assembleQuickComposerTexts, quickComposerAgentTemplate } from './quick-composer-texts'
import type { QuickLaunchOptions } from './quick-launch-options'
import {
  checkAgentLaunchPreferences,
  launchPreferencesToSessionOptions
} from '../../../../shared/agent-launch-preference-check'
import { buildHubTaskEnvironment } from '../../../../shared/omnios-task-binding'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tuiAgentToAgentKind } from '@/lib/telemetry'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  launchOptions?: QuickLaunchOptions
  prompt: string
  hubTaskId?: string
  draftPrompt: string | null | undefined
  settings: GlobalSettings | null | undefined
  repoConnectionId: string | null | undefined
  platform: NodeJS.Platform
  shell: AgentStartupShell | null | undefined
  isRemote: boolean
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

export type QuickComposerStartup = {
  startupPlan: AgentStartupPlan | null
  backendStartup: WorktreeCreationRequest['startup']
  telemetry: AgentStartedTelemetry | null
}

export function buildQuickComposerStartup(input: QuickComposerStartupInput): QuickComposerStartup {
  const { agent, settings } = input
  const checked = agent
    ? checkAgentLaunchPreferences(agent, input.launchOptions?.preferences)
    : null
  if (checked && !checked.ok) {
    throw new Error(checked.message)
  }
  const explicitOptions = checked?.ok
    ? launchPreferencesToSessionOptions(checked.preferences)
    : undefined
  const inputDraft = input.launchOptions?.submitPrompt ? null : input.draftPrompt
  const inputPrompt = input.launchOptions?.submitPrompt
    ? input.draftPrompt || input.prompt
    : input.prompt
  const { prompt, draftPrompt } = assembleQuickComposerTexts({
    prompt: inputPrompt,
    draftPrompt: inputDraft,
    hubTaskId: input.hubTaskId,
    agentTemplate: quickComposerAgentTemplate(
      agent,
      settings?.agentTemplates,
      input.launchOptions?.agentTemplateId,
      input.launchOptions?.project?.agent
    ),
    project: input.launchOptions?.project
  })
  const launchDefaults = agent
    ? resolveChatLaunchDefaults(
        agent,
        settings,
        input.shell ?? 'posix',
        input.launchOptions?.chatBypass
      )
    : null
  const agentEnv = {
    ...launchDefaults?.agentEnv,
    ...buildHubTaskEnvironment(input.hubTaskId)
  }
  const sessionOptions =
    explicitOptions ??
    (agent === null
      ? undefined
      : resolveInitialNativeChatSessionOptions(
          {
            experimentalNativeChat: settings?.experimentalNativeChat,
            openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
            nativeChatSessionOptions: settings?.nativeChatSessionOptions
          },
          {
            agent,
            agentArgs: launchDefaults?.agentArgs,
            agentEnv,
            agentCommandOverride: settings?.agentCmdOverrides?.[agent],
            shell: input.shell ?? 'posix',
            ...(draftPrompt
              ? { promptDelivery: 'draft' as const, launchDraftText: draftPrompt }
              : {}),
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              input.repoConnectionId
            )
          }
        ))
  const draftLaunchPlan =
    agent === null || !draftPrompt
      ? null
      : buildAgentDraftLaunchPlan({
          agent,
          draft: draftPrompt,
          cmdOverrides: settings?.agentCmdOverrides ?? {},
          agentArgs: launchDefaults?.agentArgs,
          agentEnv,
          sessionOptions,
          sessionOptionsOverrideAgentArgs: Boolean(explicitOptions),
          platform: input.platform,
          shell: input.shell ?? undefined,
          isRemote: input.isRemote
        })
  let startupPlan: AgentStartupPlan | null = null
  if (draftLaunchPlan) {
    startupPlan = {
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
  } else if (agent !== null) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt,
      cmdOverrides: settings?.agentCmdOverrides ?? {},
      agentArgs: launchDefaults?.agentArgs,
      agentEnv,
      sessionOptions,
      sessionOptionsOverrideAgentArgs: Boolean(explicitOptions),
      platform: input.platform,
      shell: input.shell ?? undefined,
      isRemote: input.isRemote,
      allowEmptyPromptLaunch: true
    })
    if (startupPlan && draftPrompt) {
      startupPlan.draftPrompt = draftPrompt
    }
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source:
            input.telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          request_kind: 'new'
        }
  const backendStartup =
    startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(agent ? { launchAgent: agent } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          ...(telemetry ? { telemetry } : {})
        }
      : undefined
  return { startupPlan, backendStartup, telemetry }
}
