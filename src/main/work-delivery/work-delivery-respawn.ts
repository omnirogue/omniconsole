/**
 * The one fresh session a delivery may start when its conversation is gone: launched through
 * `createAgentSession` on a verified account with room, the same way a session transfer launches.
 */

import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { parseSessionReference, type SessionReferenceAgent } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { WorkDeliveryHold, messageOf, type WorkPane } from './work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from './work-delivery-kind'

type RespawnRuntime = Pick<
  OrcaRuntimeService,
  | 'agentLaunchReadiness'
  | 'createAgentSession'
  | 'getTerminalPaneKey'
  | 'getReportedProviderSessionsForPane'
>

/** The host that runs the workspace, which chooses the fresh start's account. */
export type FreshStartAccount = { hostId: string; runtimeId: string }

export function freshStartRequest(input: {
  operationId: string
  folder: string
  agent: SessionReferenceAgent
  brief: string
  target: WorkDeliveryTarget
  account: FreshStartAccount
}): RuntimeCreateAgentSessionRequest {
  const { target, account } = input
  return {
    clientOperationId: input.operationId,
    worktree: `path:${input.folder}`,
    agent: input.agent,
    prompt: input.brief,
    promptDelivery: 'auto-submit',
    presentation: 'background',
    revealInSidebar: true,
    viewMode: 'terminal',
    // Why: a fresh start uses a verified account with room, or waits; never an unverified fallback.
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: account.hostId,
      expectedRuntimeId: account.runtimeId
    },
    ...(target.model || target.effort
      ? {
          launchPreferences: {
            ...(target.model ? { model: target.model } : {}),
            ...(target.effort ? { effort: target.effort } : {})
          }
        }
      : {})
  }
}

export async function respawnFreshSession(
  runtime: RespawnRuntime,
  delivery: ClaimableDelivery,
  target: WorkDeliveryTarget,
  brief: string,
  operationId: string
): Promise<WorkPane & { title: string; ref: string; conversationId: string | null }> {
  const agent = parseSessionReference(target.ref)?.agent ?? 'claude'
  if (!target.folder) {
    throw new WorkDeliveryHold(
      'not_found',
      'Its folder is not recorded, so a fresh session has nowhere to start.'
    )
  }
  const readiness = await runtime
    .agentLaunchReadiness({ worktree: `path:${target.folder}`, agent, preview: false })
    .catch((error: unknown) => {
      throw new WorkDeliveryHold('not_found', `Its folder cannot be opened: ${messageOf(error)}`)
    })
  const request = freshStartRequest({
    operationId,
    folder: target.folder,
    agent,
    brief,
    target,
    account: { hostId: readiness.workspace.hostId, runtimeId: readiness.runtimeId }
  })
  const created = await runtime
    .createAgentSession(request, {
      launchCause: { trigger: 'agent-session-create', requestId: operationId }
    })
    .catch((error: unknown) => {
      throw respawnRefusal(error)
    })
  const paneKey = created.terminal.paneKey ?? runtime.getTerminalPaneKey(created.terminal.handle)
  if (!paneKey) {
    throw new Error(
      `A fresh session for ${delivery.workItem} started, but its pane cannot be named.`
    )
  }
  return {
    paneKey,
    worktreeId: created.terminal.worktreeId,
    tabId: created.terminal.tabId ?? null,
    archived: false,
    title: created.terminal.title ?? delivery.workItem,
    ref: `pane:${paneKey}`,
    conversationId: runtime.getReportedProviderSessionsForPane(paneKey)[0]?.id ?? null
  }
}

/** A refusal before the spawn started nothing and is retried; an unknown outcome is passed on. */
export function respawnRefusal(error: unknown): unknown {
  const fields = (error ?? {}) as { agentSessionOperationOutcome?: unknown; code?: unknown }
  if (fields.agentSessionOperationOutcome === 'unknown') {
    return error
  }
  const reason = fields.code === 'agent_session_account_unverified' ? 'account_at_limit' : 'error'
  return new WorkDeliveryHold(reason, messageOf(error))
}
