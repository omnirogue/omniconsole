import { recordingAgentTemplate } from './session-agent-template-record'
import type { SessionAgentTemplate } from '../../../shared/session-agent-template'
import { sessionContextLaunchBinding } from './session-context-store'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'
import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import { nativeChatEnabledByPreference } from '../../../shared/native-chat-preference'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import {
  checkAgentLaunchPreferences,
  type AgentLaunchPreferenceSelection
} from '../../../shared/agent-launch-preference-check'

type LaunchAgentSessionContinuationArgs = {
  sessionContext?: readonly SessionContextAttachment[]
  /** Recorded on the tab the launch creates. */
  agentTemplate?: SessionAgentTemplate
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  workspacePath: string
  initialCwd?: string | null
  launchSource: LaunchSource
  /** Model and effort for this launch; refused before any tab exists when the agent cannot apply them. */
  launchPreferences?: AgentLaunchPreferenceSelection | null
  /** Session-only environment (an account profile's config directory). */
  launchEnv?: Record<string, string> | null
  /** Keep an explicit source Chat / Terminal choice for a continuation. */
  viewModePreference?: 'chat' | 'terminal'
  /** 'draft' leaves the prompt in the new session's composer for the person to finish and send. */
  promptDelivery?: 'submit-after-ready' | 'draft'
  /** Revalidate the caller's pending launch after asynchronous preparation. */
  shouldLaunch?: () => boolean
  /** Called once the tab exists, with a promise that settles when the prompt reached the agent. */
  onLaunched?: (launched: { tabId: string | null; promptDelivered: Promise<boolean> }) => void
}

export async function detectAgentSessionContinuationAgents(
  worktreeId: string
): Promise<TuiAgent[]> {
  const state = useAppStore.getState()
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return connectionId
    ? state.ensureRemoteDetectedAgents(connectionId)
    : runtimeEnvironmentId
      ? state.ensureRuntimeDetectedAgents(runtimeEnvironmentId)
      : state.ensureDetectedAgents(worktreeId)
}

async function ensureAgentAvailable(
  agent: TuiAgent,
  worktreeId: string,
  shouldLaunch?: () => boolean
): Promise<boolean> {
  const state = useAppStore.getState()
  const label = getAgentLabel(agent)
  if (!isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    toast.error(
      translate(
        'components.agentSessionContinuation.agentDisabled',
        '{{agent}} is disabled in Agent settings.',
        { agent: label }
      )
    )
    return false
  }

  let detectedAgents: TuiAgent[]
  try {
    detectedAgents = await detectAgentSessionContinuationAgents(worktreeId)
  } catch (error) {
    console.error('Agent detection failed for session continuation', error)
    detectedAgents = []
  }
  if (shouldLaunch?.() === false) {
    return false
  }
  if (detectedAgents.includes(agent)) {
    return true
  }

  toast.error(
    translate(
      'components.agentSessionContinuation.agentUnavailable',
      '{{agent}} was not detected on this workspace host.',
      { agent: label }
    )
  )
  return false
}

async function preflightAgentTrust(args: {
  agent: TuiAgent
  workspacePath: string
  connectionId: string | null | undefined
}): Promise<void> {
  const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preset || !args.workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Why: a failed best-effort trust write should not discard a prepared handoff.
  }
}

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  sessionContext,
  agentTemplate,
  worktreeId,
  groupId,
  workspacePath,
  initialCwd,
  launchSource,
  launchPreferences,
  launchEnv,
  viewModePreference,
  promptDelivery = 'submit-after-ready',
  shouldLaunch,
  onLaunched
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  if (shouldLaunch?.() === false) {
    return false
  }
  if (!(await ensureAgentAvailable(agent, worktreeId, shouldLaunch))) {
    return false
  }
  if (shouldLaunch?.() === false) {
    return false
  }
  const label = getAgentLabel(agent)
  const preferenceCheck = checkAgentLaunchPreferences(agent, launchPreferences)
  if (!preferenceCheck.ok) {
    toast.error(
      translate(
        'components.agentSessionContinuation.launchPreferencesRefused',
        'Could not start {{agent}}: {{reason}}',
        { agent: label, reason: preferenceCheck.message }
      )
    )
    return false
  }

  const connectionId = getConnectionIdFromState(useAppStore.getState(), worktreeId)
  await preflightAgentTrust({ agent, workspacePath, connectionId })
  if (shouldLaunch?.() === false) {
    return false
  }

  const launchState = useAppStore.getState()
  const localOwner =
    getConnectionIdFromState(launchState, worktreeId) === null &&
    getRuntimeEnvironmentIdForWorktree(launchState, worktreeId) === null
  const localContext = localOwner
    ? getLocalAgentPreflightContext(launchState, undefined, undefined, worktreeId)
    : undefined
  const nativeOwner =
    localOwner &&
    !localContext?.wslDistro &&
    !localContext?.wslDefault &&
    (!localContext?.projectRuntime ||
      (localContext.projectRuntime.status === 'resolved' &&
        localContext.projectRuntime.runtime.kind === 'windows-host'))
  if (shouldLaunch?.() === false) {
    return false
  }
  const result = launchAgentInNewTab({
    onSessionCreated: recordingAgentTemplate(
      sessionContextLaunchBinding(sessionContext ?? [], worktreeId),
      agentTemplate
    ),
    agent,
    worktreeId,
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery,
    // Only proven native readers gain the automatic Work view. Explicit user view
    // preferences still flow through the existing launch settings on every host.
    ...(viewModePreference
      ? { viewModePreference }
      : nativeOwner && nativeChatEnabledByPreference(launchState.settings)
        ? { viewModePreference: 'chat' as const }
        : {}),
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    ...(preferenceCheck.preferences ? { launchPreferences: preferenceCheck.preferences } : {}),
    ...(launchEnv && Object.keys(launchEnv).length > 0 ? { launchEnv } : {}),
    onPromptDelivered: () =>
      toast.success(
        translate(
          'components.agentSessionContinuation.sent',
          'Session context sent to {{agent}} in a new session.',
          { agent: label }
        )
      )
  })
  if (!result) {
    notifyLaunchFailed(label)
    return false
  }
  onLaunched?.({
    tabId: result.tabId,
    promptDelivered: Promise.all([
      result.launchCompletion ?? Promise.resolve(true),
      result.promptDeliveryResult?.then((delivery) => delivery.delivered) ?? Promise.resolve(true)
    ])
      .then(([launched, delivered]) => launched && delivered)
      .catch(() => false)
  })

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified) {
          notifyDeliveryFailed(label)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label)
      })
  }
  return true
}

function notifyLaunchFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.launchFailed',
      'Could not start a new {{agent}} session.',
      { agent: agentLabel }
    )
  )
}

function notifyDeliveryFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.deliveryFailed',
      'The new {{agent}} session started, but its context could not be sent.',
      { agent: agentLabel }
    )
  )
}
