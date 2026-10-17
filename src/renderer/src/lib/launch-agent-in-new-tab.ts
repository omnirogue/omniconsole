import { conversationLauncherArgs } from './launch-agent-in-new-tab-defaults'
import { attemptAcpChatLaunch, shouldAttemptAcpChatLaunch } from './launch-agent-acp-attempt'
import {
  attemptClaudeStructuredChatLaunch,
  shouldAttemptClaudeStructuredLaunch
} from './launch-agent-claude-structured-attempt'
import { attemptCodexStructuredChatLaunch } from './launch-agent-codex-structured-attempt'
import { chatBypassLaunchArgs, chatBypassLaunchEnv } from '../../../shared/chat-launch-permissions'
import { useAppStore } from '@/store'
import { conversationLaunchReservationIsCurrent } from './conversation-launch-reservation'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { launchAgentPrompt } from '@/lib/launch-agent-outcome-prompt'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { appendLaunchedTabOrder } from './launch-agent-in-new-tab-order'
import { buildAgentTabStartupCommand } from '@/lib/agent-tab-startup-command'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tryTerminalCreationRoute } from '../store/terminals/terminal-workspace-routing'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchWebHostAgentTab } from '@/lib/launch-agent-web-host-result'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { launchPreferencesToSessionOptions } from '../../../shared/agent-launch-preference-check'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

export type { LaunchAgentInNewTabArgs, LaunchAgentInNewTabResult }
export { shouldQueueTerminalFocusAfterMenuClose } from './launch-agent-in-new-tab-types'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-types'

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Submission mode follows `promptInjectionMode`: argv/flag agents fold the
 * prompt into the launch command; followup-path agents launch empty and get a
 * post-ready draft paste. Callers can override via `promptDelivery`.
 *
 * Returns `null` when no startup plan can be built (e.g. a whitespace-only prompt).
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  if (args.conversationLauncher && args.launchEnv && Object.keys(args.launchEnv).length) {
    args = { ...args, acpFallback: true }
  }
  const {
    agent,
    worktreeId,
    groupId,
    agentArgs,
    initialCwd,
    promptDelivery = 'auto-submit',
    quickCommandLabel,
    launchPlatform,
    onPromptDelivered,
    launchPreferences,
    launchEnv,
    viewModePreference,
    tabId: requestedTabId
  } = args
  const store = useAppStore.getState()
  if (!conversationLaunchReservationIsCurrent(store, args)) {
    return null
  }
  const route = tryTerminalCreationRoute(store, worktreeId)
  if (!route) {
    return null
  }
  const worktree = store.getKnownWorktreeById(worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  const resolvedLaunchPlatform =
    launchPlatform ??
    (repo
      ? getAgentLaunchPlatformForRepo(
          repo,
          repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktreeId)
        )
      : CLIENT_PLATFORM)
  // Why: SSH remotes deploy the shim as plain `omni`, so skip the Linux-only `omni-ide` rename for remote launches.
  const isRemote = repo ? repoIsRemote(repo) : false
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform: resolvedLaunchPlatform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  let effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  if (args.conversationLauncher) {
    effectiveAgentArgs = conversationLauncherArgs(agent, effectiveAgentArgs, queuedShell ?? 'posix')
  }
  // Why: a per-launch account profile rides on top of the agent's default env so the
  // rest of the launch (yolo flags, hooks) stays exactly what the settings say.
  let agentEnv = {
    ...resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
    ...launchEnv
  }
  const explicitSessionOptions = launchPreferencesToSessionOptions(launchPreferences ?? undefined)
  const trimmedPrompt = launchAgentPrompt(args, resolvedLaunchPlatform, isRemote)
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeOptions = {
    agent,
    preferredViewMode: viewModePreference,
    promptDelivery: viewModePromptDelivery,
    launchDraftText: trimmedPrompt,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      getConnectionIdFromState(store, worktreeId)
    )
  }
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, initialViewModeOptions)
  const acpChatLaunch = shouldAttemptAcpChatLaunch(store, agent, viewModePreference)
  const chatLaunch =
    initialViewModeProps.viewMode === 'chat' || viewModePreference === 'chat' || acpChatLaunch
  // Not folded into `chatLaunch`: the Claude Agent SDK lane never forces chat mode
  // on a launch that resolved to the terminal, it only claims one that was already
  // going to chat. ACP does force it, because opting an agent into ACP is itself a
  // request for the structured view.
  const claudeChatLaunch =
    chatLaunch &&
    !acpChatLaunch &&
    shouldAttemptClaudeStructuredLaunch(store, agent, viewModePreference)
  if (chatLaunch) {
    effectiveAgentArgs = chatBypassLaunchArgs(agent, effectiveAgentArgs, queuedShell ?? 'posix')
    agentEnv = chatBypassLaunchEnv(agent, agentEnv)
  }
  const startupPlanBase = {
    agent,
    cmdOverrides,
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv,
    // Why: an explicit actor choice must reach the command even when the user's
    // default args carry a model flag, so it overrides instead of deferring to them.
    sessionOptions:
      explicitSessionOptions ??
      (args.conversationLauncher
        ? {}
        : resolveInitialNativeChatSessionOptions(store.settings, {
            ...initialViewModeOptions,
            agentArgs: effectiveAgentArgs,
            agentEnv,
            shell: queuedShell ?? 'posix'
          })),
    sessionOptionsOverrideAgentArgs:
      Boolean(explicitSessionOptions) || args.conversationLauncher === true,
    // Why: an account chosen for this launch must not be re-pinned by a shell wrapper.
    ...(launchEnv && Object.keys(launchEnv).length > 0 ? { bypassShellFunctions: true } : {})
  }
  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = planLaunchAgentStartupPrompt({
    base: startupPlanBase,
    prompt: trimmedPrompt,
    promptDelivery,
    isFollowupPath,
    submitFollowup: Boolean(args.outcome?.text.trim())
  })
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (!startupPlan) {
    return null
  }

  const acpLaunchResult = attemptAcpChatLaunch({
    args,
    store,
    acpChatLaunch,
    startupPlan,
    sessionOptions: startupPlanBase.sessionOptions,
    hasPrompt,
    promptDelivery,
    trimmedPrompt,
    relaunch: () => launchAgentInNewTab({ ...args, acpFallback: true })
  })
  if (acpLaunchResult) {
    return acpLaunchResult
  }

  if (isWebRuntimeSessionActive(route.runtimeEnvironmentId)) {
    return launchWebHostAgentTab(
      {
        agent,
        worktreeId,
        environmentId: route.runtimeEnvironmentId,
        groupId,
        cwd: initialCwd,
        startupPlan,
        prompt: trimmedPrompt,
        promptDelivery,
        pastePromptAfterReady: pasteDraftAfterLaunch,
        submitPastedPrompt,
        agentArgs:
          chatLaunch && (hasPrompt || agentArgs !== undefined) ? effectiveAgentArgs : agentArgs,
        // Why: omission means terminal locally, but would let a paired host apply
        // its own default; send the client's resolved terminal choice explicitly.
        viewMode: initialViewModeProps.viewMode ?? 'terminal',
        onPromptDelivered,
        onSessionCreated: args.onSessionCreated,
        navigate: args.navigate,
        submissionId: args.submissionId
      },
      args.reservedConversationTabId
    )
  }

  // After the web-runtime branch, so a paired host keeps its own route, and before
  // the Codex decision, which refuses `claude` outright with reason 'agent'.
  const claudeLaunchResult = attemptClaudeStructuredChatLaunch({
    args,
    store,
    claudeChatLaunch,
    startupPlan,
    sessionOptions: startupPlanBase.sessionOptions,
    hasPrompt,
    promptDelivery,
    trimmedPrompt,
    relaunch: () => launchAgentInNewTab({ ...args, acpFallback: true })
  })
  if (claudeLaunchResult) {
    return claudeLaunchResult
  }

  const codexLaunchResult = attemptCodexStructuredChatLaunch({
    args,
    store,
    startupPlan,
    sessionOptions: startupPlanBase.sessionOptions,
    hasPrompt,
    promptDelivery,
    trimmedPrompt,
    shell: queuedShell ?? 'posix'
  })
  if (codexLaunchResult) {
    return codexLaunchResult
  }

  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const command = buildAgentTabStartupCommand(args, startupPlan, trimmedPrompt, promptDelivery)
  const tab = store.createTab(worktreeId, groupId, undefined, {
    ...(requestedTabId ? { id: requestedTabId } : {}),
    ...(args.reservedConversationTabId
      ? { replaceConversationDraft: true, pendingStartup: command }
      : {}),
    ...(args.navigate === false ? { activate: false } : {}),
    launchAgent: agent,
    quickCommandLabel,
    ...initialViewModeProps
  })
  args.onSessionCreated?.(tab.id)
  seedNativeChatAppliedSessionOptions(tab.id, agent, startupPlan.sessionOptions)
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  if (!args.reservedConversationTabId) {
    store.queueTabStartupCommand(tab.id, command)
  }
  if (args.navigate === false) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
  }

  // Why: fire-and-forget the paste-after-ready delivery so callers keep the synchronous { tabId, startupPlan } signature.
  // Why: safe to call unconditionally — the helper short-circuits (no paste) for native-prefill agents already holding the draft.
  if (hasPrompt && promptDelivery === 'draft' && pasteDraftAfterLaunch === null) {
    // Why: the draft rode in on argv (Claude --prefill etc.), so no paste runs
    // and deliverLaunchPromptToAgentTab never seeds. Mirror it into chat here.
    seedNativeChatLaunchDraftForAgentTab({ tabId: tab.id, agent, text: trimmedPrompt })
  }
  if (pasteDraftAfterLaunch !== null) {
    const timeoutNotice = createPasteReadinessTimeoutNotice({
      worktreeId,
      tabId: tab.id,
      agent,
      submitted: submitPastedPrompt
    })
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: promptDelivery === 'submit-after-ready',
      onTimeout: timeoutNotice.onTimeout
    }).then((delivered) => {
      if (delivered) {
        if (agent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when OmniConsole submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
    })
    if (promptDelivery === 'submit-after-ready') {
      promptDeliveryResult = deliveryPromise
    } else {
      void deliveryPromise.catch((error) =>
        console.error('Prompt delivery failed after launch', error)
      )
    }
  } else if (hasPrompt) {
    onPromptDelivered?.()
  }

  // Why: without setActiveTabType('terminal') a worktree showing an editor keeps rendering it and the new tab stays hidden.
  if (args.navigate !== false) {
    store.setActiveTabType('terminal')
  }

  appendLaunchedTabOrder(worktreeId, tab.id)

  return {
    tabId: tab.id,
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}
