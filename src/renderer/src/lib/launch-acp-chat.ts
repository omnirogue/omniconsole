import { toast } from 'sonner'
import type { AcpStructuredAgent } from '../../../shared/acp-agent-recipes'
import type { AcpLaunchFailureReason, AcpLaunchSupport } from '../../../shared/acp-launch-support'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { startStructuredChatLaunch } from './structured-agent-session-launch'

function acpFallbackReason(reason: AcpLaunchFailureReason): string {
  switch (reason) {
    case 'disabled':
      return translate('components.native-chat.acp.disabled', 'ACP is disabled for this agent.')
    case 'remote':
      return translate(
        'components.native-chat.acp.remote',
        'ACP is not available on this remote execution host.'
      )
    case 'wsl':
      return translate(
        'components.native-chat.acp.wsl',
        'ACP is not available for WSL sessions yet.'
      )
    case 'windows':
      return translate(
        'components.native-chat.acp.windows',
        'ACP is not available for Windows sessions yet.'
      )
    case 'custom-launch':
      return translate(
        'components.native-chat.acp.customLaunch',
        'This launch uses custom arguments, a command, an account environment, or a different working directory.'
      )
    case 'binary-missing':
      return translate(
        'components.native-chat.acp.binaryMissing',
        'The ACP command was not found on the execution host PATH.'
      )
    case 'bun-missing':
      return translate(
        'components.native-chat.acp.bunMissing',
        'OMP requires Bun on the execution host PATH.'
      )
    case 'exit-unproven':
      return translate(
        'components.native-chat.acp.exitUnproven',
        'The ACP probe child could not be confirmed stopped.'
      )
    case 'initialize-failed':
      return translate(
        'components.native-chat.acp.initializeFailed',
        'The agent did not complete ACP initialization.'
      )
  }
}

export async function launchAcpChat(input: {
  agent: AcpStructuredAgent
  worktreeId: string
  options?: Record<string, SessionOptionValue>
  prompt?: string
  onPromptDelivered?: () => void
  onSessionCreated?: (tabId: string) => void
  navigate?: boolean
  launchKey?: string
  groupId?: string
  refusal?: AcpLaunchFailureReason
  fallback: () => Promise<{ delivered: boolean; failureNotified: boolean }>
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  let support: AcpLaunchSupport & { transport?: 'acp' }
  try {
    support = input.refusal
      ? { supported: false, reason: input.refusal }
      : await callStructuredAgentSession({ kind: 'local' }, 'agentSession.createSupport', {
          worktree: toRuntimeWorktreeSelector(input.worktreeId),
          agent: input.agent,
          transport: 'acp'
        })
    if (support.supported && support.transport !== 'acp') {
      support = { supported: false, reason: 'initialize-failed' }
    }
  } catch {
    support = { supported: false, reason: 'initialize-failed' }
  }
  if (!support.supported) {
    toast.info(
      translate(
        'components.native-chat.acp.fallback',
        '{{agent}} is opening in terminal chat: {{reason}}',
        {
          agent: input.agent,
          reason: acpFallbackReason(support.reason)
        }
      ),
      { description: support.detail }
    )
    return input.fallback()
  }
  return startStructuredChatLaunch(
    input.worktreeId,
    input.options,
    input.prompt,
    input.onPromptDelivered,
    input.agent,
    'acp',
    {
      navigate: input.navigate,
      launchKey: input.launchKey,
      groupId: input.groupId,
      onSessionCreated: input.onSessionCreated
    }
  )
}
