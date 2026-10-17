/**
 * A turn a login failure killed ("Login expired", "OAuth token has expired", "Please run
 * /login", a 401 authentication_error) is recorded once and, when that login works again,
 * continued once in the same conversation. Usage-limit failures are not this: capacity recovery
 * owns them, and it may change accounts, which this never does.
 */

import { createHash } from 'node:crypto'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  classifyAgentTurnFailure,
  type AgentTurnFailureKind
} from '../../shared/agent-turn-failure'
import { isCodexAuthError } from '../../shared/codex-auth-errors'
import { conversationProfileOf } from '../../shared/conversation-resume-command'
import { formatSessionReference } from '../../shared/session-reference'
import type { CodexRolloutTurnFailure } from '../runtime/codex-rollout-turn-failure'
import type { WorkLoginCut } from '../work-delivery/work-delivery-claimer-types'
import {
  isLoginKilledTurnSettled,
  type LoginKilledTurn,
  type LoginKilledTurnStore
} from './login-killed-turns-store'

const LOGIN_FAILURE_TEXT =
  /login expired|oauth token (?:has )?(?:expired|been revoked)|oauth session expired|please run \/login|not logged in|failed to authenticate|authentication_error/i
const REASON_MAX_LENGTH = 300

export function isLoginFailureText(reason: string | undefined): boolean {
  if (!reason || classifyAgentTurnFailure(reason) === 'usage-limit') {
    return false
  }
  return LOGIN_FAILURE_TEXT.test(reason) || isCodexAuthError(reason)
}

/** A provider failure reason as the drain's exemption reads it: every login failure is `authentication`. */
export function turnFailureKind(reason: string | undefined): AgentTurnFailureKind {
  return isLoginFailureText(reason) ? 'authentication' : classifyAgentTurnFailure(reason)
}

export type LoginKilledTurnSeed = Omit<LoginKilledTurn, 'state' | 'recordedAt' | 'updatedAt'>

export function loginKilledTurnId(ref: string, killedAt: number): string {
  return createHash('sha256').update(`${ref}\n${killedAt}`).digest('hex').slice(0, 32)
}

/** Queue entries with this prefix may go to a pane whose last turn a login failure ended. */
export const LOGIN_RESUME_ENTRY_PREFIX = 'login-resume:'

/** The queue entry id: the same failure queues its continue prompt once per pane. */
export const loginResumePromptId = (record: Pick<LoginKilledTurn, 'id'>): string =>
  `${LOGIN_RESUME_ENTRY_PREFIX}${record.id}`

function seed(input: {
  agent: 'claude' | 'codex'
  sessionId: string
  paneKey: string
  worktreeId: string
  transcriptPath: string | undefined
  killedAt: number
  reason: string
  model?: string
}): LoginKilledTurnSeed {
  const ref = formatSessionReference({
    agent: input.agent,
    sessionId: input.sessionId,
    hostId: 'local'
  })
  return {
    id: loginKilledTurnId(ref, input.killedAt),
    ref,
    sessionId: input.sessionId,
    provider: input.agent,
    paneKey: input.paneKey,
    worktreeId: input.worktreeId,
    home: input.transcriptPath
      ? (conversationProfileOf(input.agent, input.transcriptPath)?.path ?? null)
      : null,
    ...(input.model ? { model: input.model } : {}),
    killedAt: input.killedAt,
    reason: input.reason.slice(0, REASON_MAX_LENGTH)
  }
}

export type LoginHookEvent = Pick<
  AgentHookEventPayload,
  'paneKey' | 'worktreeId' | 'connectionId' | 'isReplay' | 'providerSession' | 'payload'
> & { stateStartedAt: number }

const agentOf = (agentType: string | undefined): 'claude' | 'codex' | null =>
  agentType === 'claude' || agentType === 'codex' ? agentType : null

/**
 * A provider-reported failed turn (Claude's StopFailure) on this computer whose words are a
 * login failure. A remote host's turns are its own to resume; a replay is not a new failure.
 */
export function loginKilledTurnFromHook(
  event: LoginHookEvent,
  transcriptPath?: string
): LoginKilledTurnSeed | null {
  const { payload } = event
  const agent = agentOf(payload.agentType)
  const sessionId = event.providerSession?.id
  if (
    event.connectionId !== null ||
    event.isReplay ||
    !agent ||
    !sessionId ||
    !event.worktreeId ||
    payload.state !== 'done' ||
    !payload.failed ||
    payload.interrupted ||
    payload.sessionBoundary ||
    payload.interactivePrompt ||
    !isLoginFailureText(payload.failureReason)
  ) {
    return null
  }
  return seed({
    agent,
    sessionId,
    paneKey: event.paneKey,
    worktreeId: event.worktreeId,
    transcriptPath: event.providerSession?.transcriptPath ?? transcriptPath,
    killedAt: event.stateStartedAt,
    reason: payload.failureReason!,
    ...(payload.model ? { model: payload.model } : {})
  })
}

/** Codex fires no hook on a failed turn; its rollout's last `task_complete` error is the trace. */
export function loginKilledTurnFromRollout(
  pane: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string },
  failure: CodexRolloutTurnFailure | null,
  hook: { stateStartedAt: number; interactive: boolean } | null
): LoginKilledTurnSeed | null {
  if (
    !failure ||
    failure.usageLimit ||
    !isLoginFailureText(failure.reason) ||
    // Any hook state entered after the failure (a resume, a question) is newer work.
    (hook && (hook.interactive || hook.stateStartedAt > failure.failedAt))
  ) {
    return null
  }
  return seed({ agent: 'codex', ...pane, killedAt: failure.failedAt, reason: failure.reason })
}

function clock(at: number, timeZone?: string): string {
  return new Date(at).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {})
  })
}

/** Exactly what the conversation is told; the time is this computer's clock. */
export function loginResumeText(killedAt: number, timeZone?: string): string {
  return `Your last turn was cut off at ${clock(killedAt, timeZone)} by a login failure on this computer. The login works again: continue where you left off.`
}

export type LoginKilledState = Pick<
  LoginKilledTurn,
  'state' | 'heldReason' | 'detail' | 'killedAt' | 'settledAt'
> & { settled: boolean; line: string }

/** The delivery line: what happened to the cut-off turn, in plain words. */
export function loginKilledLine(record: LoginKilledTurn, timeZone?: string): string {
  const cut = `Cut off at ${clock(record.killedAt, timeZone)} by a login failure`
  switch (record.state) {
    case 'pending':
      return `${cut}; it continues once ${record.detail ?? 'the login works again'}.`
    case 'reopening':
      return `${cut}; the login works again and the conversation is reopening.`
    case 'queued':
      return `${cut}; the login works again and the continue prompt is queued.`
    case 'resumed':
      return `${cut}; resumed at ${clock(record.settledAt ?? record.updatedAt, timeZone)}.`
    case 'superseded':
      return `${cut}; it was continued before the login came back${record.detail ? ` (${record.detail})` : ''}.`
    case 'held':
      return `${cut}; not resumed: ${record.detail ?? record.heldReason ?? 'held'}.`
  }
}

let activeStore: LoginKilledTurnStore | null = null

export function setLoginKilledTurnStore(store: LoginKilledTurnStore | null): void {
  activeStore = store
}

export function getLoginKilledTurnStore(): LoginKilledTurnStore | null {
  return activeStore
}

/** Records a seen login failure once; false when there is no store or it was already recorded. */
export function recordLoginKilledTurn(seed: LoginKilledTurnSeed | null): boolean {
  return seed !== null && activeStore !== null && activeStore.add(seed)
}

/**
 * Codex reports no hook when a turn fails, so its pane still reads `working` from the prompt. A
 * recorded, unsettled login failure of that pane after the turn began says the turn is over.
 */
export function loginKilledWhileWorking(paneKey: string, workingSince: number): string | null {
  const record = activeStore
    ?.list()
    .findLast(
      (candidate) =>
        candidate.paneKey === paneKey &&
        candidate.provider === 'codex' &&
        candidate.killedAt >= workingSince &&
        !isLoginKilledTurnSettled(candidate)
    )
  return record?.reason ?? null
}

/**
 * `WorkDeliveryDeps.loginCut`: the newest login failure in `paneKey` at or after `since`, with the pane
 * a resume continued it in. Superseded counts as none: newer work ran, so nothing is cut off.
 */
export function loginCutOf(paneKey: string, since: number): WorkLoginCut | null {
  const record = activeStore
    ?.list()
    .findLast((candidate) => candidate.paneKey === paneKey && candidate.killedAt >= since)
  if (!record || record.state === 'superseded') {
    return null
  }
  const state = record.state === 'resumed' || record.state === 'held' ? record.state : 'cut_off'
  const pane = state === 'resumed' && record.target ? record.target : record
  return {
    state,
    paneKey: pane.paneKey,
    ...(pane.worktreeId ? { worktreeId: pane.worktreeId } : {})
  }
}

/** The newest login-killed turn of `ref` on this computer, or null when none was recorded. */
export function loginKilledState(ref: string): LoginKilledState | null {
  const record = activeStore?.list().findLast((candidate) => candidate.ref === ref)
  if (!record) {
    return null
  }
  return {
    state: record.state,
    ...(record.heldReason ? { heldReason: record.heldReason } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    killedAt: record.killedAt,
    ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
    settled: isLoginKilledTurnSettled(record),
    line: loginKilledLine(record)
  }
}
