import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import type { QuickLaunchOptions } from './quick-launch-options'
import { quickComposerAgentTemplate, withQuickLaunchProject } from './quick-composer-texts'
import {
  checkAgentLaunchPreferences,
  launchPreferencesToSessionOptions
} from '../../../../shared/agent-launch-preference-check'
import type { ComposerModel } from './composer-model'

type FolderSubmitOrchestrationInput = Pick<
  ComposerModel,
  | 'clearNewWorkspaceDraft'
  | 'createFolderWorkspace'
  | 'decisions'
  | 'disabledTuiAgents'
  | 'folderCreateDisabled'
  | 'folderSourceRepos'
  | 'folderTargetConnectionId'
  | 'folderTargetIsRemote'
  | 'folderTargetRuntimeEnvironmentId'
  | 'isSubmissionCancelled'
  | 'lastAutoNameRef'
  | 'linkedWorkItem'
  | 'name'
  | 'note'
  | 'onCreated'
  | 'persistDraft'
  | 'resolvePendingSmartGitHubSubmit'
  | 'selectedProjectGroup'
  | 'setCreateError'
  | 'setCreating'
  | 'settings'
  | 'taskSourceContext'
  | 'telemetrySource'
>

import { useCallback } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { resolveStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  getFolderWorkspaceAgentLaunchPlatform,
  resolveFolderWorkspaceLaunchDraft,
  submitFolderWorkspaceCreate
} from '@/components/sidebar/folder-workspace-composer-submit'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { translate } from '@/i18n/i18n'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { toast } from 'sonner'

export function useFolderSubmitOrchestration(input: FolderSubmitOrchestrationInput) {
  const {
    clearNewWorkspaceDraft,
    createFolderWorkspace,
    decisions,
    disabledTuiAgents,
    folderCreateDisabled,
    folderSourceRepos,
    folderTargetConnectionId,
    folderTargetIsRemote,
    folderTargetRuntimeEnvironmentId,
    isSubmissionCancelled,
    lastAutoNameRef,
    linkedWorkItem,
    name,
    note: typedNote,
    onCreated,
    persistDraft,
    resolvePendingSmartGitHubSubmit,
    selectedProjectGroup,
    setCreateError,
    setCreating,
    settings,
    taskSourceContext,
    telemetrySource
  } = input
  const { canResolveFolderSmartGitHubSubmit } = decisions

  const submitFolderTarget = useCallback(
    async (requestedAgent: TuiAgent | null, launchOptions?: QuickLaunchOptions): Promise<void> => {
      if (!selectedProjectGroup?.parentPath || folderCreateDisabled) {
        return
      }
      setCreateError(null)
      setCreating(true)
      try {
        const shouldResolveSmartGitHubSubmit = canResolveFolderSmartGitHubSubmit({
          hasFolderSourceRepos: folderSourceRepos.length > 0
        })
        const smartGitHubSettlement = await settleComposerSubmit(
          shouldResolveSmartGitHubSubmit
            ? resolvePendingSmartGitHubSubmit()
            : Promise.resolve({ kind: 'none' } as const),
          isSubmissionCancelled
        )
        if (smartGitHubSettlement.status === 'cancelled') {
          return
        }
        const smartGitHubResolution = smartGitHubSettlement.value
        const smartGitHubMetadata =
          smartGitHubResolution.kind === 'none' ? null : smartGitHubResolution
        const submitLinkedWorkItem = smartGitHubMetadata?.linkedWorkItem ?? linkedWorkItem
        const agent =
          requestedAgent && isTuiAgentEnabled(requestedAgent, disabledTuiAgents)
            ? requestedAgent
            : null
        if (isSubmissionCancelled()) {
          return
        }
        const checked = agent
          ? checkAgentLaunchPreferences(agent, launchOptions?.preferences)
          : null
        if (checked && !checked.ok) {
          throw new Error(checked.message)
        }
        const explicitOptions = checked?.ok
          ? launchPreferencesToSessionOptions(checked.preferences)
          : undefined
        const agentTemplate = quickComposerAgentTemplate(
          agent,
          settings?.agentTemplates,
          launchOptions?.agentTemplateId,
          launchOptions?.project?.agent
        )
        // Why the note: a folder workspace's first message is built from it.
        const note = withQuickLaunchProject(typedNote, launchOptions?.project)
        const folderLaunchDraftText =
          agent && submitLinkedWorkItem
            ? resolveFolderWorkspaceLaunchDraft(submitLinkedWorkItem, note, agentTemplate)
            : null
        const agentArgs = agent
          ? resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
          : undefined
        const agentEnv = agent
          ? resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
          : undefined
        const platform = getFolderWorkspaceAgentLaunchPlatform(selectedProjectGroup)
        const shell = resolveStartupShell(
          platform,
          resolveLocalWindowsAgentStartupShell({
            platform,
            isRemote: Boolean(selectedProjectGroup.connectionId),
            terminalWindowsShell: settings?.terminalWindowsShell
          }) ?? undefined
        )
        const folderWorkspaceCreated = await submitFolderWorkspaceCreate({
          projectGroup: selectedProjectGroup,
          name: smartGitHubMetadata?.workspaceName ?? name,
          lastAutoName: lastAutoNameRef.current,
          linkedWorkItem: submitLinkedWorkItem,
          linkedTaskSourceContext: taskSourceContext,
          note,
          quickAgent: agent,
          agentTemplate,
          autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
          agentCmdOverrides: settings?.agentCmdOverrides,
          agentArgs,
          agentEnv,
          submitPrompt: launchOptions?.submitPrompt,
          onLaunched: launchOptions?.onLaunched,
          chatBypass:
            launchOptions?.chatBypass ||
            (nativeChatEnabledByPreference({
              experimentalNativeChat: settings?.experimentalNativeChat
            }) &&
              settings?.openAgentTabsInChatByDefault === true),
          sessionOptionsOverrideAgentArgs: Boolean(explicitOptions),
          sessionOptions:
            explicitOptions ??
            (agent
              ? resolveInitialNativeChatSessionOptions(settings, {
                  agent,
                  agentArgs,
                  agentEnv,
                  shell,
                  ...(folderLaunchDraftText
                    ? { promptDelivery: 'draft' as const, launchDraftText: folderLaunchDraftText }
                    : {}),
                  nativeChatTranscriptIsLocalReadable:
                    isNativeChatTranscriptLocalReadable(folderTargetConnectionId)
                })
              : undefined),
          terminalWindowsShell: settings?.terminalWindowsShell,
          isRemote: folderTargetIsRemote,
          launchSource: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          runtimeEnvironmentId: folderTargetRuntimeEnvironmentId,
          createFolderWorkspace: (input) =>
            createFolderWorkspace(input, {
              runtimeEnvironmentId: folderTargetRuntimeEnvironmentId
            }),
          onOpenChange: (open) => {
            if (!open) {
              if (persistDraft) {
                clearNewWorkspaceDraft()
              }
              onCreated?.()
            }
          }
        })
        if (!folderWorkspaceCreated) {
          setCreateError({
            title: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedTitle',
              'Folder workspace creation failed'
            ),
            message: translate(
              'auto.hooks.useComposerState.folderWorkspaceCreateFailedMessage',
              'The folder workspace could not be created. Check the error details above, then try again.'
            )
          })
        }
      } catch (error) {
        if (isSubmissionCancelled()) {
          return
        }
        const formattedError = formatWorkspaceCreateError(error)
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        setCreating(false)
      }
    },
    [
      clearNewWorkspaceDraft,
      createFolderWorkspace,
      canResolveFolderSmartGitHubSubmit,
      disabledTuiAgents,
      folderCreateDisabled,
      folderTargetConnectionId,
      folderTargetIsRemote,
      folderTargetRuntimeEnvironmentId,
      folderSourceRepos.length,
      isSubmissionCancelled,
      linkedWorkItem,
      name,
      typedNote,
      onCreated,
      persistDraft,
      resolvePendingSmartGitHubSubmit,
      selectedProjectGroup,
      settings,
      taskSourceContext,
      telemetrySource,
      lastAutoNameRef,
      setCreateError,
      setCreating
    ]
  )

  return {
    submitFolderTarget
  }
}
