// Which workspace an Agent Session History row would resume into, and whether the
// structured route can take it there.
//
// Rewired for this fork: upstream asks its `agent-launch-routing` predicate and reads
// the negotiated capability list. Neither exists here — this fork decides the
// structured route in `structured-native-chat-availability.ts`, and a local host is
// this build, so the resume capability it would negotiate is one it always has.

import { canUseStructuredNativeChat } from '@/lib/structured-native-chat-availability'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import {
  resolveAiVaultSessionResumeInChatEligibility,
  type AiVaultResumeInChatEligibility
} from './ai-vault-session-resume-in-chat'
import type {
  AiVaultSessionResumeState,
  AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'

export function resolveAiVaultSessionResumeInChatForWorkspace(args: {
  session: AiVaultSession
  resumeState: AiVaultSessionResumeState
  activeWorkspaceId: string | null
  targetState: AiVaultSessionResumeTargetState
}): AiVaultResumeInChatEligibility {
  const targetWorkspaceId = args.resumeState.usesSessionWorktree
    ? args.resumeState.worktreeId
    : (args.resumeState.worktreeId ?? args.activeWorkspaceId)
  const targetWorkspacePath = targetWorkspaceId
    ? resolveAiVaultTargetWorkspacePath(args.targetState, targetWorkspaceId)
    : null
  return resolveAiVaultSessionResumeInChatEligibility({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath,
    structuredRouteAvailable:
      isAgentSessionHandleProvider(args.session.agent) &&
      Boolean(targetWorkspaceId) &&
      canUseStructuredNativeChat(useAppStore.getState(), targetWorkspaceId as string)
  })
}
