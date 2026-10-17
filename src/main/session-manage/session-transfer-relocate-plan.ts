/**
 * The pieces of `session relocate` that read and word things: what the source says about the
 * conversation, each step's request, a proposal for a person, and the result.
 */

import type { SessionHostOrigin } from '../../shared/session-host-authority'
import {
  SESSION_HOST_RELOCATION_PROVIDERS,
  type SessionHostRelocationProvider
} from '../../shared/session-host-capabilities'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import type { SessionHostReceivedObservation } from '../../shared/session-host-reply-schema'
import type {
  SessionRelocationOutcome,
  SessionRelocationResult
} from '../../shared/session-relocation-types'
import type { HostStepOutcome, SessionTransferHostPort } from './session-transfer-host-port'
import type { SessionRelocationRecord } from './session-transfer-relocate-record'

export type RelocationStepRequest = Omit<SessionHostRequest, 'operationId' | 'origin'>

export function relocationRequest(
  step: RelocationStepRequest,
  operationId: string,
  origin: SessionHostOrigin
): SessionHostRequest {
  return { ...step, operationId, origin } as SessionHostRequest
}

/** A field of a completed step's result, when its success flag (if named) is true. */
export function resultField<T>(
  outcome: HostStepOutcome | null,
  flag: string | false,
  field: string
): T | undefined {
  if (outcome?.kind !== 'recorded' || outcome.operation.state !== 'completed') {
    return undefined
  }
  const result = outcome.operation.result as Record<string, unknown> | undefined
  if (!result || (flag !== false && result[flag] !== true)) {
    return undefined
  }
  return result[field] as T | undefined
}

function isRelocationProvider(agent: string | undefined): agent is SessionHostRelocationProvider {
  return (SESSION_HOST_RELOCATION_PROVIDERS as readonly string[]).includes(agent ?? '')
}

/** What the source host says now; a conversation that cannot be verified there never moves. */
export async function observeRelocationSource(
  source: SessionTransferHostPort,
  conversationId: string
): Promise<
  | { row: SessionHostReceivedObservation; provider: SessionHostRelocationProvider }
  | { stop: string; code: string }
> {
  const reply = await source.observe({ conversationIds: [conversationId], includeArchived: true })
  if (reply.status !== 'ok') {
    return {
      stop: `${source.label} could not say how the conversation is (${reply.refusal.message}) Nothing was changed.`,
      code: reply.refusal.code
    }
  }
  const row = reply.sessions.find((session) => session.conversationId === conversationId)
  if (!row) {
    return {
      stop: `${source.label} does not run that conversation, so it cannot move it. Nothing was changed.`,
      code: 'unknown-conversation'
    }
  }
  if (row.verdict === 'unverifiable') {
    return {
      stop: `${source.label} cannot verify whether the conversation is running, and one that may still run is never moved. Nothing was changed.`,
      code: 'not-eligible'
    }
  }
  if (!isRelocationProvider(row.provider?.agent)) {
    return {
      stop: `Only Claude and Codex conversations can be moved; this one runs ${row.provider?.agent ?? 'an unknown agent'}. Nothing was changed.`,
      code: 'unsupported-capability'
    }
  }
  return { row, provider: row.provider!.agent as SessionHostRelocationProvider }
}

/** For an unattended caller: the move written up for a person, who must ask for it themselves. */
export function relocationProposal(
  deps: { source: SessionTransferHostPort; destination: SessionTransferHostPort },
  row: SessionHostReceivedObservation
): string {
  const what = row.provider?.agent ? `this ${row.provider.agent} conversation` : 'this conversation'
  return `Proposed: move ${what} from ${deps.source.label} to ${deps.destination.label}. Moving a conversation needs a person to ask for it, so nothing was changed. Renting or setting up another computer is only ever proposed, never done.`
}

export function relocationResult(
  deps: { source: SessionTransferHostPort; destination: SessionTransferHostPort },
  input: { conversationId: string },
  record: SessionRelocationRecord | null,
  observed: SessionHostReceivedObservation | null,
  outcome: SessionRelocationOutcome,
  summary: string,
  code?: string
): SessionRelocationResult {
  const agent = observed?.provider?.agent
  return {
    relocation: record?.relocation ?? null,
    outcome,
    provider: record?.provider ?? (isRelocationProvider(agent) ? agent : null),
    source: {
      hostId: deps.source.hostId,
      label: deps.source.label,
      conversationId: record?.source.conversationId ?? input.conversationId
    },
    destination: { hostId: deps.destination.hostId, label: deps.destination.label },
    ...(outcome === 'relocated' && record?.grant ? { ownerEpoch: record.grant.ownerEpoch } : {}),
    steps: record?.steps ?? [],
    summary,
    ...(code ? { code } : {})
  }
}

const UNSUPPORTED = new Set(['unsupported-capability', 'unknown-capability'])

/**
 * Before anything moves: each host must speak this provider's relocation, bundle calls included (a
 * build that advertised relocation before the bundle calls existed answers them as unsupported).
 * The probe names a move that does not exist, so a capable host refuses it as not eligible.
 */
export async function relocationBundleSupport(
  deps: {
    source: SessionTransferHostPort
    destination: SessionTransferHostPort
    mintOperationId(): string
  },
  conversationId: string,
  provider: SessionHostRelocationProvider
): Promise<{ stop: string; code: string } | null> {
  const probe = {
    relocation: deps.mintOperationId(),
    conversationId,
    provider,
    path: 'probe',
    offset: 0
  }
  const answers: [
    SessionTransferHostPort,
    { status: string; refusal?: { code: string; message: string } }
  ][] = [
    [deps.source, await deps.source.relocationBundleRead({ ...probe, length: 1 })],
    [
      deps.destination,
      await deps.destination.relocationBundleWrite({ ...probe, size: 0, base64: '' })
    ]
  ]
  for (const [port, answer] of answers) {
    const code = answer.refusal?.code
    if (code && UNSUPPORTED.has(code)) {
      return {
        stop: `${port.label} cannot move ${provider} conversations (${answer.refusal!.message.replace(/\.$/, '')}). Update OmniConsole there first. Nothing was changed.`,
        code
      }
    }
    if (code === 'host-unreachable' || code === 'renegotiate') {
      return { stop: `${port.label} could not be reached. Nothing was changed.`, code }
    }
  }
  return null
}
