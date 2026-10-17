/**
 * Starts the target of a `--host` move through the existing agent launch (`createAgentSession`
 * with host-owned account selection, as `omni session launch` does), its first prompt the brief.
 * The acceptance wait listens before the spawn. An uncertain launch is reported, never repeated.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { RuntimeCreateAgentSessionResult } from '../../shared/agent-session-host-authority'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import type { FinishedTurn } from '../next-steps/next-step-turn-signal'
import { onNextStepTurnSignal } from '../next-steps/next-step-suggestion-slot'
import type { RpcContext } from '../runtime/rpc/core'
import { SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS } from '../runtime/rpc/methods/session-manage-schemas'
import { prepareSessionAction } from '../runtime/rpc/methods/session-manage-support'
import { waitForAskReply, type AskWaitEntry } from './session-manage-ask-wait'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import {
  transferBriefTag,
  type TransferPending,
  type TransferSession
} from './session-manage-transfer-contract'
import {
  transferAcknowledgement,
  transferAcknowledgementInstruction
} from './session-transfer-acknowledgement'
import type { HostMovePlan } from './session-transfer-host-contract'

export type HostLaunchInput = {
  context: RpcContext
  journal: (action: 'session.create', target: TransferSession, operation: unknown) => Promise<void>
  capture(target: TransferSession, turn: FinishedTurn): void
  /** Stops an acceptance wait still listening when the transfer ends. */
  release?(stop: () => void): void
}

const ROW_WAIT_MS = 60_000
// The same bound `terminal.createAgentSession` puts on a prompt from a client.
const MAX_LAUNCH_PROMPT_BYTES = 256 * 1024
// The target starts, fetches and checks out before it can accept; more than one answer's wait.
const ACCEPT_WAIT_MS = 2 * SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS
// Why: a fresh pane and the unique brief tag tie the turn; the host's clock may differ from ours.
const LAUNCH_PROMPT: AskWaitEntry = { state: 'delivered', createdAt: 0 }

function partial(
  operationId: string,
  where: string,
  error: unknown,
  handle?: string
): SessionManagePartialError {
  return new SessionManagePartialError(
    error instanceof Error ? error.message : String(error),
    `launch ${operationId} ${handle ? `started ${handle}` : 'may have started a session'} on ${where}; it was recorded before dispatch, so inspect that computer before retrying and do not launch it again`
  )
}

/** A target not yet in the sidebar: the pane, workspace and host it is being started with. */
function provisionalTarget(
  source: TransferSession,
  identity: { paneKey: string; tabId: string; worktreeId: string; path: string; hostId: string },
  title: string
): TransferSession {
  const { paneKey, tabId, worktreeId, path, hostId } = identity
  const placed = { paneKey, tabId, worktreeId, title, hostId, worktreePath: path }
  return {
    source: { kind: 'pty', paneKey, worktreeId },
    agentProcess: null,
    entry: {
      ...source.entry,
      ...placed,
      terminal: null,
      kind: 'terminal',
      state: 'unknown',
      verdict: 'unverifiable',
      agentForeground: null,
      keepGoing: false,
      archived: false
    },
    row: {
      ...source.row,
      ...placed,
      rowKey: paneKey,
      viewKey: paneKey,
      kind: 'terminal',
      structuredSessionId: null,
      archived: false
    }
  }
}

export async function launchOnSshHost(
  input: HostLaunchInput,
  plan: HostMovePlan,
  source: TransferSession,
  title: string,
  prompt: string
): Promise<{ target: TransferSession; pending: TransferPending }> {
  const { context, journal } = input
  const { runtime } = context
  const id = randomUUID()
  const marker = transferBriefTag(id)
  const acknowledgement = transferAcknowledgement(id)
  const sent = `${marker}${prompt}\n\n${transferAcknowledgementInstruction(acknowledgement)}`
  if (Buffer.byteLength(sent, 'utf8') > MAX_LAUNCH_PROMPT_BYTES) {
    throw new SessionManageRefusal(
      'The brief is too long to start a session with (over 256 KiB). Nothing was started.'
    )
  }
  const tabId = randomUUID()
  const leafId = randomUUID()
  const paneKey = makePaneKey(tabId, leafId)
  const worktreeId = plan.workspace.id
  const operationId = `${Date.now()}-${randomBytes(16).toString('hex')}`
  const where = `${plan.label} (${plan.hostId})`
  const provisional = provisionalTarget(
    source,
    { paneKey, tabId, worktreeId, path: plan.workspace.path, hostId: plan.hostId },
    title
  )
  await journal('session.create', provisional, {
    operationId,
    host: plan.hostId,
    worktreeId,
    paneKey,
    tabId,
    leafId,
    agent: source.entry.agent,
    state: 'pending'
  })
  // Listen before the spawn: the reply can only be this pane's turn carrying this brief's tag.
  const seen: { target: TransferSession | null } = { target: null }
  const stop = new AbortController()
  input.release?.(() => stop.abort())
  const onAbort = (): void => stop.abort()
  context.signal?.addEventListener('abort', onAbort, { once: true })
  const conversation: ConversationSource = { kind: 'pty', paneKey, worktreeId }
  const wait = waitForAskReply(
    {
      subscribe: onNextStepTurnSignal,
      readEntry: () => LAUNCH_PROMPT,
      withdrawIfQueued: () => false
    },
    {
      rowKey: conversationSourceRowKey(conversation),
      marker,
      sentText: sent,
      timeoutMs: ACCEPT_WAIT_MS,
      requireCompleteReply: true,
      onCompleteReply: (turn) => {
        if (!seen.target) {
          throw new Error('The new session replied before this computer could list it.')
        }
        input.capture(seen.target, turn)
      },
      signal: stop.signal
    }
  ).finally(() => context.signal?.removeEventListener('abort', onAbort))
  let created: RuntimeCreateAgentSessionResult
  try {
    created = await runtime.createAgentSession(
      {
        clientOperationId: operationId,
        worktree: `id:${worktreeId}`,
        agent: source.entry.agent as TuiAgent,
        prompt: sent,
        promptDelivery: 'auto-submit',
        presentation: 'background',
        revealInSidebar: true,
        viewMode: 'terminal',
        placement: { tabId, leafId },
        sshAccountSelection: {
          policy: 'best-verified',
          expectedHostId: plan.hostId,
          expectedRuntimeId: runtime.getStatus().runtimeId
        }
      },
      {
        ...(context.signal ? { signal: context.signal } : {}),
        launchCause: {
          trigger: 'session-transfer',
          reference: { transferId: id },
          requestId: operationId,
          parentPaneKey: source.entry.paneKey ?? undefined
        }
      }
    )
  } catch (error) {
    stop.abort()
    const outcome = (error as { agentSessionOperationOutcome?: unknown } | null)
      ?.agentSessionOperationOutcome
    // Why: a refusal before the spawn started nothing; an unknown outcome may have.
    throw outcome === 'unknown' ? partial(operationId, where, error) : error
  }
  const { handle } = created.terminal
  if (
    runtime.getTerminalPaneKey(handle) !== paneKey ||
    created.terminal.worktreeId !== worktreeId
  ) {
    stop.abort()
    throw partial(operationId, where, 'The launch receipt did not prove the reserved pane.', handle)
  }
  // Best effort, as `session launch --title`: a missing title never repeats the launch.
  await runtime.renameTerminal(handle, title).catch(() => undefined)
  const deadline = Date.now() + ROW_WAIT_MS
  while (!seen.target) {
    if (stop.signal.aborted || Date.now() >= deadline) {
      stop.abort()
      const reason = context.signal?.aborted
        ? 'The caller stopped waiting.'
        : 'The new session did not appear in the sidebar in time.'
      throw partial(operationId, where, reason, handle)
    }
    const prepared = await prepareSessionAction(context, { paneKey }).catch(() => null)
    if (
      prepared?.source &&
      prepared.entry.terminal === handle &&
      prepared.row.hostId === plan.hostId &&
      prepared.row.worktreeId === worktreeId
    ) {
      seen.target = prepared
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return { target: seen.target, pending: { sent, wait, acknowledgement } }
}
