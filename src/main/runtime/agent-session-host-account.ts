import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  agentLaunchRefusal,
  type AgentLaunchAccountReceipt
} from '../../shared/agent-launch-account'
import { SessionPrepAccountPreparationError } from '../session-prep/session-prep-ids'
import {
  prepareAgentSessionLocalAccount,
  type LaunchAccountCapacity
} from './agent-session-local-account'
import {
  prepareAgentSessionSshAccount,
  type AgentLaunchWorkspace
} from './agent-session-ssh-account'

export { agentLaunchRefusal }

export type PreparedAgentSessionAccount = {
  env: Record<string, string>
  /** Synchronous pre-spawn fence; throws a coded refusal when the pick is no longer current. */
  assertCurrent: () => void
  receipt?: AgentLaunchAccountReceipt
  fableVerified: boolean
}

/** Host-owned best-verified selection: `local` uses this runtime's rows, `ssh:` asks the relay. */
export async function prepareAgentSessionHostAccount(args: {
  request: RuntimeCreateAgentSessionRequest
  workspace: AgentLaunchWorkspace
  currentWorkspace: () => AgentLaunchWorkspace | null
  runsInWsl: (workspace: AgentLaunchWorkspace) => boolean
  capacity: LaunchAccountCapacity | null
  signal?: AbortSignal
}): Promise<PreparedAgentSessionAccount | null> {
  const selection = args.request.sshAccountSelection
  if (!selection) {
    return null
  }
  if (selection.expectedHostId === 'local') {
    return prepareAgentSessionLocalAccount(args)
  }
  try {
    return await prepareAgentSessionSshAccount(args)
  } catch (error) {
    // Why the same instance: session prep's own callers rely on this class and its text.
    if (error instanceof SessionPrepAccountPreparationError && !('code' in error)) {
      Object.assign(error, { code: 'agent_session_account_unverified' })
    }
    throw error
  }
}

/** Refuses before spawn when the resolved model is Fable and the pick never verified its window. */
export function assertLaunchModelVerified(
  selected: Pick<PreparedAgentSessionAccount, 'fableVerified' | 'receipt'> | null,
  resolvedModel: string | null | undefined
): void {
  if (!selected || !resolvedModel || !/fable/i.test(resolvedModel) || selected.fableVerified) {
    return
  }
  const hostId = selected.receipt?.hostId
  const host = !hostId || hostId === 'local' ? 'this computer' : hostId
  throw agentLaunchRefusal(
    'agent_session_account_unverified',
    `This launch resolves to ${resolvedModel} on ${host}, but the chosen account's Fable window was not verified. Nothing launched. Pass --model <a non-Fable model>, or run the same command again when a Fable reading is fresh.`,
    { model: resolvedModel, ...(hostId ? { hostId } : {}) }
  )
}
