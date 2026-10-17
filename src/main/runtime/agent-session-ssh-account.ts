import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  agentLaunchRefusal,
  type AgentLaunchAccountReceipt
} from '../../shared/agent-launch-account'
import type { CapacityProvider } from '../../shared/provider-account-capacity'
import type { SessionPrepAccount } from '../../shared/session-prep-account'
import { listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { prepareSessionPrepRemoteAccountSelection } from '../session-prep/session-prep-remote-account'
import { sessionPrepSshBinding } from '../session-prep/session-prep-ssh-binding'

export type AgentLaunchWorkspace = {
  id: string
  path: string
  connectionId: string | null
  repo: { id: string; path: string; executionHostId?: string | null } | null
  folderWorkspace: { id: string; folderPath: string; executionHostId?: string | null } | null
}

/** The relay picks from its own profiles and pool, so only its winner and age are known. */
export function sshLaunchAccountReceipt(args: {
  hostId: `ssh:${string}`
  provider: CapacityProvider
  model: string | undefined
  account: SessionPrepAccount
  readingAgeMs: number
}): AgentLaunchAccountReceipt {
  const slot = args.account.oauthTokenFile?.match(/\/(slot-\d+)\/\.oauth-token$/)?.[1]
  return {
    policy: 'best-verified',
    hostId: args.hostId,
    provider: args.provider,
    label: slot ? `pool ${slot}` : args.account.configRoot,
    choiceId: null,
    remainingPercent: args.account.remainingPercent,
    boundBy: null,
    readingAt: args.account.readingAt,
    readingAgeMs: args.readingAgeMs,
    // Why: the relay counts the Fable window only when the request names a Fable model.
    fableVerified: /fable/i.test(args.model ?? ''),
    verified: null,
    considered: null,
    excluded: [],
    why: `most fresh verified headroom on the SSH host (${args.account.remainingPercent}%)`
  }
}

/** Select on the execution host, then keep the same workspace and registration until spawn. */
export async function prepareAgentSessionSshAccount(args: {
  request: RuntimeCreateAgentSessionRequest
  workspace: AgentLaunchWorkspace
  currentWorkspace: () => AgentLaunchWorkspace | null
  signal?: AbortSignal
}) {
  const selection = args.request.sshAccountSelection
  if (!selection) {
    return null
  }
  if (args.request.viewMode !== 'terminal') {
    throw new Error('Best-verified SSH account selection requires an interactive terminal session.')
  }
  if (args.request.launchPreferences?.codexAccountId) {
    throw new Error('A pinned account cannot be combined with best-verified SSH selection.')
  }
  const snapshot = (workspace: AgentLaunchWorkspace | null) => {
    if (!workspace) {
      throw agentLaunchRefusal(
        'agent_session_host_mismatch',
        'The launch workspace is no longer registered. Nothing launched.'
      )
    }
    const host =
      workspace.repo?.executionHostId ??
      workspace.folderWorkspace?.executionHostId ??
      (workspace.connectionId ? `ssh:${workspace.connectionId}` : 'local')
    if (
      !workspace.connectionId ||
      host !== selection.expectedHostId ||
      host !== `ssh:${workspace.connectionId}`
    ) {
      throw agentLaunchRefusal(
        'agent_session_host_mismatch',
        'The launch workspace is not on the requested SSH host. Nothing launched.',
        { expectedHostId: selection.expectedHostId, workspaceHostId: host }
      )
    }
    return JSON.stringify([
      workspace.id,
      workspace.path,
      workspace.repo?.id ?? workspace.folderWorkspace?.id,
      workspace.repo?.path ?? workspace.folderWorkspace?.folderPath,
      host,
      sessionPrepSshBinding(workspace.connectionId, listRegisteredSshTargets())
    ])
  }
  const expected = snapshot(args.workspace)
  const connected = () => {
    if (args.signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }
  connected()
  const model = args.request.launchPreferences?.model
  const prepared = await prepareSessionPrepRemoteAccountSelection(
    args.workspace.connectionId!,
    args.request.agent,
    model
  )
  const assertCurrent = () => {
    connected()
    if (snapshot(args.currentWorkspace()) !== expected) {
      throw agentLaunchRefusal(
        'agent_session_host_mismatch',
        'The SSH workspace or target changed during account selection. Nothing launched.'
      )
    }
    if (!Number.isFinite(prepared.expiresAt) || performance.now() > prepared.expiresAt) {
      throw agentLaunchRefusal(
        'agent_session_account_unverified',
        'The prepared SSH account is no longer fresh. Nothing launched.'
      )
    }
  }
  assertCurrent()
  const receipt = sshLaunchAccountReceipt({
    hostId: selection.expectedHostId as `ssh:${string}`,
    provider: prepared.account.provider,
    model,
    account: prepared.account,
    readingAgeMs: prepared.readingAgeMs
  })
  return { env: prepared.env, assertCurrent, receipt, fableVerified: receipt.fableVerified }
}
