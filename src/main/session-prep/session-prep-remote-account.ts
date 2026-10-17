import type { TuiAgent } from '../../shared/tui-agent'
import { sessionPrepAccountEnv, type SessionPrepAccount } from '../../shared/session-prep-account'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { isJsonRpcMethodNotFoundError } from '../providers/ssh-git-relay-errors'
import { SessionPrepAccountPreparationError } from './session-prep-ids'

export async function prepareSessionPrepRemoteAccount(
  connectionId: string,
  agent: TuiAgent,
  model?: string
): Promise<Record<string, string>> {
  return (await prepareSessionPrepRemoteAccountSelection(connectionId, agent, model)).env
}

export async function prepareSessionPrepRemoteAccountSelection(
  connectionId: string,
  agent: TuiAgent,
  model?: string
): Promise<{
  env: Record<string, string>
  expiresAt: number
  /** The relay's reply, for receipts; it names display paths only, never a credential. */
  account: SessionPrepAccount
  readingAgeMs: number
}> {
  if (agent !== 'claude' && agent !== 'codex') {
    throw new SessionPrepAccountPreparationError(
      `Account selection on SSH is not available for ${agent}.`
    )
  }
  try {
    const startedAt = performance.now()
    const account = await requireSshGitProvider(connectionId).prepareSessionAccount(agent, model)
    const receivedAt = performance.now()
    const age = account.ageAtReplyMs + Math.max(0, receivedAt - startedAt - account.processingMs)
    return {
      env: sessionPrepAccountEnv(account),
      expiresAt: receivedAt + 60_000 - age,
      account,
      readingAgeMs: age
    }
  } catch (error) {
    if (isJsonRpcMethodNotFoundError(error)) {
      throw new SessionPrepAccountPreparationError(
        'This SSH relay needs an update before it can select an account. Reconnect with the updated app; nothing launched.'
      )
    }
    if (
      error instanceof Error &&
      /No (claude|codex) account with fresh verified capacity/.test(error.message)
    ) {
      throw new SessionPrepAccountPreparationError(
        `No ${agent} account has fresh verified capacity on this SSH host. Check its signed-in accounts and usage; nothing launched.`
      )
    }
    throw new SessionPrepAccountPreparationError(
      `Cannot verify ${agent} capacity on this SSH host. Check its connection and signed-in accounts; nothing launched.`
    )
  }
}
