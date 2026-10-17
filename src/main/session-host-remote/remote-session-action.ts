/**
 * One control on a session another computer runs, carried out by that computer (Phase 4 E). The
 * requesting Mac observes the host's own view of the conversation, fences the request on what it
 * saw (owner epoch, turn, organization revision), and sends it once. It never answers for the host:
 * an older host, an unsupported action or a host that cannot be reached comes back as a refusal
 * with the host's words, and nothing is done here instead (no local action, no terminal input).
 * A lost reply is followed by `sessionHost.operation`; the request is sent again only when the
 * reachable host positively says it never recorded it.
 */

import type { SessionHostClientReply } from '../../shared/session-host-client'
import { SESSION_HOST_UNREACHABLE } from '../../shared/session-host-client'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import {
  requireSessionHostAction,
  type SessionHostNegotiation
} from '../../shared/session-host-negotiation'
import type { SessionHostOwnerDirectory } from '../../shared/session-host-owner-directory'
import {
  SESSION_HOST_ACTION_SPECS,
  type SessionHostAction,
  type SessionHostObserveParams,
  type SessionHostOperationParams,
  type SessionHostRequest
} from '../../shared/session-host-protocol'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import {
  sessionHostRetryRule,
  type SessionHostReceivedRefusal,
  type SessionHostRetryRule
} from '../../shared/session-host-refusal'
import type {
  SessionHostExecuteReplySchema,
  SessionHostObserveReplySchema,
  SessionHostOperationReplySchema,
  SessionHostReceivedObservation,
  SessionHostReceivedOperation
} from '../../shared/session-host-reply-schema'
import type { SessionExecutionVerdict } from '../../shared/session-host-verdict'
import type { z } from 'zod'

type ObserveReply = SessionHostClientReply<z.infer<typeof SessionHostObserveReplySchema>>
type ExecuteReply = SessionHostClientReply<z.infer<typeof SessionHostExecuteReplySchema>>
type OperationReply = SessionHostClientReply<z.infer<typeof SessionHostOperationReplySchema>>

export type RemoteSessionClient = {
  negotiation(): SessionHostNegotiation | null
  observe(params?: SessionHostObserveParams): Promise<ObserveReply>
  execute(request: SessionHostRequest): Promise<ExecuteReply>
  operation(params: SessionHostOperationParams): Promise<OperationReply>
}

/** How the requesting Mac names the session: its pane here, else the provider conversation. */
export type RemoteSessionTarget = {
  paneKey: string | null
  tabId: string | null
  provider?: { agent: string; sessionId: string } | null
}

export type RemoteSessionOutcome =
  | {
      kind: 'completed'
      hostId: string
      conversationId: string
      operation: SessionHostReceivedOperation
    }
  /** Admitted but not settled, or settled `unconfirmed`: bytes may have moved; never resent. */
  | {
      kind: 'pending'
      hostId: string
      conversationId: string
      operationId: string
      state: string
    }
  | { kind: 'would'; hostId: string; conversationId: string; verdict: SessionExecutionVerdict }
  | {
      kind: 'refused'
      refusal: SessionHostReceivedRefusal
      retry: SessionHostRetryRule
      verdict: SessionExecutionVerdict
      operationId?: string
    }

export type RemoteSessionActionInput<A extends SessionHostAction = SessionHostAction> = {
  /** The connection this client reaches (aliases resolve to one owner in the directory). */
  connection: string
  target: RemoteSessionTarget
  action: A
  payload: SessionHostPayloads[A]
  origin: SessionHostOrigin
  dryRun: boolean
}

export const REMOTE_SESSION_NOT_LISTED: SessionHostReceivedRefusal = {
  code: 'unknown-conversation',
  message:
    'The computer that runs this session does not list it as one it carries out controls for (it may not have adopted it yet). Nothing was sent.'
}

function refused(
  refusal: SessionHostReceivedRefusal,
  extra: { verdict?: SessionExecutionVerdict; operationId?: string } = {}
): RemoteSessionOutcome {
  return {
    kind: 'refused',
    refusal,
    retry: sessionHostRetryRule(refusal.code),
    // Why unverifiable by default: only the owning host's own observation can say live or exited.
    verdict: extra.verdict ?? 'unverifiable',
    ...(extra.operationId ? { operationId: extra.operationId } : {})
  }
}

export function findRemoteObservation(
  sessions: readonly SessionHostReceivedObservation[],
  target: RemoteSessionTarget
): SessionHostReceivedObservation | null {
  const providerMatches = (row: SessionHostReceivedObservation): boolean =>
    !target.provider ||
    (row.provider?.agent === target.provider.agent &&
      row.provider.sessionId === target.provider.sessionId)
  const onPane = target.paneKey ? sessions.filter((row) => row.ref.paneKey === target.paneKey) : []
  if (onPane.length > 0) {
    // A pane reused by a different conversation is not the session the person selected.
    const held = onPane.filter(providerMatches)
    if (held.length <= 1) {
      return held[0] ?? null
    }
    // Why the one the host sees there now: a pane's earlier conversations stay registered to it.
    const seen = held.filter((row) => row.entry)
    return seen.length === 1 ? seen[0]! : null
  }
  // A missing split must never redirect control into another leaf of the same tab.
  const byTab =
    !target.paneKey && target.tabId
      ? sessions.filter((row) => row.ref.tabId === target.tabId && providerMatches(row))
      : []
  if (byTab.length === 1) {
    return byTab[0]!
  }
  const provider = target.provider
  const matches = provider
    ? sessions.filter(
        (row) =>
          row.provider?.agent === provider.agent && row.provider.sessionId === provider.sessionId
      )
    : []
  // Why exactly one: two registrations of one provider conversation are the host's to resolve.
  return matches.length === 1 ? matches[0]! : null
}

function outcomeOf(
  operation: SessionHostReceivedOperation,
  verdict: SessionExecutionVerdict
): RemoteSessionOutcome {
  const { host, conversationId, operationId } = operation
  if (operation.state === 'completed') {
    return { kind: 'completed', hostId: host.hostId, conversationId, operation }
  }
  if (operation.state === 'refused') {
    return refused(
      operation.refusal ?? {
        code: 'invalid-request',
        message: 'That computer refused the request without saying why. Nothing was sent.'
      },
      { verdict, operationId }
    )
  }
  return {
    kind: 'pending',
    hostId: host.hostId,
    conversationId,
    operationId,
    state: operation.state
  }
}

async function settleLostReply(
  client: RemoteSessionClient,
  request: SessionHostRequest,
  verdict: SessionExecutionVerdict
): Promise<RemoteSessionOutcome> {
  const asked = await client.operation({
    operationId: request.operationId,
    conversationId: request.conversationId
  })
  if (asked.status === 'ok' && asked.found) {
    return outcomeOf(asked.operation, verdict)
  }
  if (asked.status === 'ok' && !asked.found) {
    // Why one identical resend: the reachable host positively never admitted this operation id.
    const again = await client.execute(request)
    return again.status === 'ok'
      ? outcomeOf(again.operation, verdict)
      : refused(again.refusal, { operationId: request.operationId })
  }
  return refused(SESSION_HOST_UNREACHABLE, {
    verdict: 'unverifiable',
    operationId: request.operationId
  })
}

export async function runRemoteSessionAction<A extends SessionHostAction>(
  deps: {
    client: RemoteSessionClient
    directory: SessionHostOwnerDirectory
    newOperationId: () => string
  },
  input: RemoteSessionActionInput<A>
): Promise<RemoteSessionOutcome> {
  const { client, directory } = deps
  const observed = await client.observe({ includeArchived: true })
  if (observed.status !== 'ok') {
    return refused(observed.refusal)
  }
  directory.noteConnection(input.connection, observed.host)
  directory.noteObservation(observed)
  const row = findRemoteObservation(observed.sessions, input.target)
  if (!row) {
    return refused(REMOTE_SESSION_NOT_LISTED, { verdict: 'unverifiable' })
  }
  const verdict = directory.verdictOf(row.conversationId, observed)
  const negotiation = client.negotiation()
  const unsupported = negotiation
    ? requireSessionHostAction(negotiation, input.action)
    : SESSION_HOST_UNREACHABLE
  if (unsupported) {
    return refused(unsupported, { verdict })
  }
  if (input.dryRun) {
    return {
      kind: 'would',
      hostId: observed.host.hostId,
      conversationId: row.conversationId,
      verdict
    }
  }
  const organization = SESSION_HOST_ACTION_SPECS[input.action].feature === 'organization'
  const request = {
    operationId: deps.newOperationId(),
    conversationId: row.conversationId,
    expectedOwnerEpoch: row.ownerEpoch,
    expectedTurnRevision: row.turnRevision,
    ...(organization && row.organizationRevision
      ? { expectedOrganizationRevision: row.organizationRevision }
      : {}),
    origin: input.origin,
    action: input.action,
    payload: input.payload
  } as SessionHostRequest
  const sent = await client.execute(request)
  if (sent.status === 'ok') {
    return outcomeOf(sent.operation, verdict)
  }
  return sent.refusal.code === 'host-unreachable'
    ? await settleLostReply(client, request, verdict)
    : refused(sent.refusal, { verdict })
}
