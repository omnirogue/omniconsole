import { isAbsolute } from 'node:path'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { isAgentSessionRecord, type AgentSessionRecord } from '../../shared/agent-session-record'
import { runProcess } from '../../shared/child-process/run-process'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCodexCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { admitsPeerInboxCodexSqliteRouting } from './peer-inbox-codex-sqlite-routing'

export type PeerInboxCodexQueueInput = {
  record: AgentSessionRecord
  threadId: string
  hint: string
  correlationNonce: string
  signal?: AbortSignal
}

export type PeerInboxCodexQueueResult =
  | { status: 'queued'; nativeItemId: string }
  | { status: 'not-started' | 'uncertain'; reason: string }

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i')
const RECEIPT = new RegExp(
  `^Queued message (${UUID_SOURCE}) for thread (${UUID_SOURCE})\\.(?:\\r?\\n)?$`
)

function admitsBoundThread(record: AgentSessionRecord, threadId: string): boolean {
  if (
    !isAgentSessionRecord(record) ||
    typeof threadId !== 'string' ||
    threadId.length !== 36 ||
    !UUID.test(threadId)
  ) {
    return false
  }
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  return (
    record.location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    record.location.wslDistro === null &&
    record.provider === 'codex' &&
    record.accountHome.variable === 'CODEX_HOME' &&
    isAbsolute(record.accountHome.path) &&
    !record.accountHome.path.includes('\0') &&
    record.lease.runtimeKind === 'tui' &&
    agentSessionLeaseAdmitsWriter(record.lease) &&
    record.lease.ownerProcess?.hostId === LOCAL_EXECUTION_HOST_ID &&
    head?.handle.provider === 'codex' &&
    head.handle.threadId === threadId
  )
}

function admitsHint(hint: string, correlationNonce: string): boolean {
  return (
    typeof hint === 'string' &&
    hint.trim().length > 0 &&
    hint.length <= 2048 &&
    Array.from(hint).every((character) => {
      const code = character.codePointAt(0)!
      return code === 10 || (code >= 32 && (code < 127 || code > 159))
    }) &&
    !/^[!/]/u.test(hint.trimStart()) &&
    typeof correlationNonce === 'string' &&
    correlationNonce.length === 36 &&
    UUID.test(correlationNonce) &&
    hint.includes(correlationNonce)
  )
}

/** Caller proves the live owner and rechecks its pinned record immediately before this call. */
export async function queuePeerInboxCodexHint(
  input: PeerInboxCodexQueueInput
): Promise<PeerInboxCodexQueueResult> {
  const { record, threadId, signal } = input
  if (signal?.aborted) {
    return { status: 'not-started', reason: 'aborted' }
  }
  if (!admitsBoundThread(record, threadId)) {
    return { status: 'not-started', reason: 'invalid-binding' }
  }
  if (!admitsPeerInboxCodexSqliteRouting(record)) {
    return { status: 'not-started', reason: 'sqlite-routing-unverifiable' }
  }
  return queueBoundCodexMessage({ ...input, accountHome: record.accountHome.path })
}

/** Transport shared by enrolled inboxes and terminal notices; the caller proves the live writer. */
export async function queueBoundCodexMessage(input: {
  accountHome: string
  threadId: string
  hint: string
  correlationNonce: string
  signal?: AbortSignal
  /** Only set after observing this writer holding this account's queue database open. */
  sqliteHome?: string
}): Promise<PeerInboxCodexQueueResult> {
  const { accountHome, threadId, hint, correlationNonce, signal, sqliteHome } = input
  if (signal?.aborted) {
    return { status: 'not-started', reason: 'aborted' }
  }
  if (
    !UUID.test(threadId) ||
    threadId.length !== 36 ||
    !isAbsolute(accountHome) ||
    accountHome.includes('\0') ||
    (sqliteHome !== undefined && sqliteHome !== accountHome)
  ) {
    return { status: 'not-started', reason: 'invalid-binding' }
  }
  if (!admitsHint(hint, correlationNonce)) {
    return { status: 'not-started', reason: 'invalid-hint' }
  }

  let command: string
  let env: NodeJS.ProcessEnv
  try {
    command = resolveCodexCommand()
    if (!isAbsolute(command) || command.includes('\0')) {
      return { status: 'not-started', reason: 'command-unavailable' }
    }
    env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        [
          'CODEX_HOME',
          'CODEX_SQLITE_HOME',
          'CODEX_THREAD_ID',
          'CODEX_REMOTE',
          'CODEX_REMOTE_ADDR'
        ].includes(key.toUpperCase())
      ) {
        delete env[key]
      }
    }
    env.CODEX_HOME = accountHome
    env = withCliRuntimeOnPath(command, env)
  } catch {
    return { status: 'not-started', reason: 'command-unavailable' }
  }
  if (signal?.aborted) {
    return { status: 'not-started', reason: 'aborted' }
  }

  try {
    const result = await runProcess({
      program: command,
      args: [
        'queue',
        ...(sqliteHome ? ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`] : []),
        '--thread',
        threadId,
        '--message',
        hint
      ],
      env,
      signal,
      timeoutMs: sqliteHome ? 30000 : 5000,
      maxOutputBytes: 4096
    })
    if (result.code !== 0 || result.signal !== null || result.timedOut || signal?.aborted) {
      return { status: 'uncertain', reason: 'queue-unconfirmed' }
    }
    const receipt = RECEIPT.exec(result.stdout)
    if (!receipt || receipt[0] !== result.stdout || receipt[2] !== threadId) {
      return { status: 'uncertain', reason: 'queue-unconfirmed' }
    }
    // The CLI receipt proves enqueue acceptance, never inbox consumption or acknowledgment.
    return { status: 'queued', nativeItemId: receipt[1]! }
  } catch {
    // runProcess also rejects post-spawn child errors, so rejection cannot establish non-delivery.
    return { status: 'uncertain', reason: 'queue-unconfirmed' }
  }
}
