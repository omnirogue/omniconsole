// The Claude Agent SDK lane's launch route (upstream #18560).
//
// Mirrors launch-acp-chat.ts on purpose: the two lanes differ in which adapter
// the host picks, not in what a person sees when one of them cannot start. Both
// ask the executing host first, and both fall back to the terminal-backed chat
// with one sentence naming the reason rather than failing the click.
//
// Why the host is asked at all: only the machine that will run the session can
// answer whether it can. Whether the agent SDK resolves, whether the platform
// can supervise the child, and which managed Claude account is active are all
// host facts, and a client that assumes them routes a launch the host then
// refuses — which reads as a chat that opened in the terminal for no reason.

import { toast } from 'sonner'
import type { ClaudeStructuredSdkRefusal } from '../../../shared/claude-structured-sdk-support'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { startStructuredChatLaunch } from './structured-agent-session-launch'

/** Every reason a Claude launch can miss the SDK lane: the settings gate, the host
 *  gate, and the per-launch shapes the structured lane cannot carry. */
export type ClaudeStructuredLaunchRefusal =
  | ClaudeStructuredSdkRefusal
  | 'remote'
  | 'wsl'
  | 'windows'
  | 'repair-required'
  | 'custom-launch'
  | 'draft-prompt'
  | 'agent'
  | 'unavailable'

/** The host answers a worktree selector it cannot resolve yet with this rather than a verdict. */
const SELECTOR_NOT_RESOLVABLE_CODE = 'selector_not_found'

/**
 * A worktree is not resolvable for a beat after `createWorktree` resolves, so a probe
 * fired immediately after creation fails instead of answering. Measured upstream at
 * under ~250ms. These delays cover it with margin and bound the wait when the selector
 * is genuinely absent.
 */
const CREATE_SUPPORT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function refusalSentence(reason: ClaudeStructuredLaunchRefusal): string {
  switch (reason) {
    case 'chat-ui-off':
      return translate('components.native-chat.claudeSdk.chatUiOff', 'Chat UI is off in Settings.')
    case 'default-view-terminal':
      return translate(
        'components.native-chat.claudeSdk.defaultViewTerminal',
        'The default view is Terminal chat.'
      )
    case 'structured-off':
      return translate(
        'components.native-chat.claudeSdk.structuredOff',
        'Structured chat is off in Settings › Experimental.'
      )
    case 'acp':
      return translate(
        'components.native-chat.claudeSdk.acp',
        'Claude is set to use ACP for structured chat.'
      )
    case 'remote':
      return translate(
        'components.native-chat.claudeSdk.remote',
        'This workspace runs on another computer.'
      )
    case 'wsl':
      return translate(
        'components.native-chat.claudeSdk.wsl',
        'This workspace, or the selected Claude account, lives in WSL.'
      )
    case 'windows':
      return translate(
        'components.native-chat.claudeSdk.windows',
        'Structured Claude chat is not available on Windows yet.'
      )
    case 'repair-required':
      return translate(
        'components.native-chat.claudeSdk.repairRequired',
        'The local runtime needs repair.'
      )
    case 'custom-launch':
      return translate(
        'components.native-chat.claudeSdk.customLaunch',
        'This launch carries its own arguments, command, account environment, or working directory.'
      )
    case 'draft-prompt':
      return translate(
        'components.native-chat.claudeSdk.draftPrompt',
        'This launch opens with a draft to edit.'
      )
    case 'agent':
      return translate(
        'components.native-chat.claudeSdk.agent',
        'This computer cannot run a structured Claude session.'
      )
    case 'unavailable':
      return translate(
        'components.native-chat.claudeSdk.unavailable',
        'The Claude Agent SDK did not answer on this computer.'
      )
  }
}

type CreateSupport = { supported: boolean; reason?: string; detail?: string }

/** The host's verdict, retried only while it cannot yet resolve the worktree. */
async function hostCreateSupport(worktreeId: string): Promise<CreateSupport> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callStructuredAgentSession<CreateSupport>(
        { kind: 'local' },
        'agentSession.createSupport',
        { worktree: toRuntimeWorktreeSelector(worktreeId), agent: 'claude' }
      )
    } catch (error) {
      const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs === undefined ||
        !hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)
      ) {
        // "Could not answer" and "answered no" are different states, and only the
        // second is a verdict — but an unanswered probe is still not a yes.
        return { supported: false, reason: 'unavailable' }
      }
      await delay(retryDelayMs)
    }
  }
}

/** Reasons the host may name back. Anything else is reported as the generic host refusal. */
const HOST_REASONS = new Set<ClaudeStructuredLaunchRefusal>([
  'remote',
  'wsl',
  'windows',
  'repair-required',
  'agent',
  'unavailable'
])

function hostRefusal(support: CreateSupport): ClaudeStructuredLaunchRefusal {
  const named = support.reason as ClaudeStructuredLaunchRefusal | undefined
  return named && HOST_REASONS.has(named) ? named : 'agent'
}

/**
 * One sentence for a fallback the person did not ask for.
 *
 * Exported because a refusal the client can settle on its own must be explained
 * WITHOUT taking the launch: the ordinary terminal path has to keep running
 * synchronously, since that is what seeds a draft into the tab it creates.
 */
export function explainClaudeStructuredFallback(reason: ClaudeStructuredLaunchRefusal): void {
  toast.info(
    translate(
      'components.native-chat.claudeSdk.fallback',
      'Claude is opening in terminal chat: {{reason}}',
      { reason: refusalSentence(reason) }
    )
  )
}

export async function launchClaudeStructuredChat(input: {
  worktreeId: string
  options?: Record<string, SessionOptionValue>
  prompt?: string
  onPromptDelivered?: () => void
  navigate?: boolean
  launchKey?: string
  groupId?: string
  onSessionCreated?: (tabId: string) => void
  /** Settled before the probe when the client already knows this launch cannot take the lane. */
  refusal?: ClaudeStructuredLaunchRefusal
  fallback: () => Promise<{ delivered: boolean; failureNotified: boolean }>
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  const refusal =
    input.refusal ??
    (await (async () => {
      const support = await hostCreateSupport(input.worktreeId)
      return support.supported ? null : hostRefusal(support)
    })())
  if (refusal) {
    explainClaudeStructuredFallback(refusal)
    return input.fallback()
  }
  return startStructuredChatLaunch(
    input.worktreeId,
    input.options,
    input.prompt,
    input.onPromptDelivered,
    'claude',
    'agent-session',
    {
      onSessionCreated: input.onSessionCreated,
      navigate: input.navigate,
      launchKey: input.launchKey,
      groupId: input.groupId
    }
  )
}
