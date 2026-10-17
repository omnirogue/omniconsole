/**
 * How a transfer or relocation talks to each participating host: `SessionHostClient` for another
 * computer, or this computer's own host service in process. Both answer in the client's reply
 * shapes, so the orchestration has one path and treats a lost reply the same way everywhere:
 * ask `sessionHost.operation`, and never send a different request in its place.
 */

import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionHostClient, SessionHostClientReply } from '../../shared/session-host-client'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import type { SessionHostReceivedRefusal } from '../../shared/session-host-refusal'
import {
  readSessionHostReply,
  SessionHostExecuteReplySchema,
  SessionHostObserveReplySchema,
  SessionHostOperationReplySchema,
  type SessionHostReceivedOperation
} from '../../shared/session-host-reply-schema'
import {
  sessionHostHolder,
  type SessionHostInProcessAuthority,
  type SessionHostRemoteAuthority
} from '../session-host/session-host-caller'
import {
  SessionHostBundleReadReplySchema,
  SessionHostBundleWriteReplySchema
} from '../../shared/session-host-relocation-bundle'
import {
  readRelocationBundleChunk,
  writeRelocationBundleChunk
} from './session-transfer-relocation-bundle'
import type { SessionHostExecutionRequest } from '../session-host/session-host-executor'
import type { SessionHostService } from '../session-host/session-host-service'

export type SessionTransferHostPort = Pick<
  SessionHostClient,
  | 'observe'
  | 'execute'
  | 'reserve'
  | 'release'
  | 'operation'
  | 'relocationBundleRead'
  | 'relocationBundleWrite'
> & {
  /** The registry identity this port reaches (from negotiation, or this host's own). */
  hostId: string
  /** How people know that computer. */
  label: string
}

function read<T>(schema: Parameters<typeof readSessionHostReply<T>>[0], raw: unknown) {
  const read = readSessionHostReply(schema, raw)
  return read.ok ? read.reply : { status: 'refused' as const, refusal: read.refusal }
}

/**
 * This computer's own host service. `authority` is who is asking here: a person's surface or the
 * CLI (`local`), or, in tests, a remote peer standing in for another computer.
 */
export function inProcessSessionTransferHostPort(
  service: SessionHostService,
  input: {
    label: string
    authority: (
      origin: SessionHostOrigin
    ) => SessionHostInProcessAuthority | SessionHostRemoteAuthority
  }
): SessionTransferHostPort {
  // Why any origin will do: a holder is the actor or the authenticated peer, never the origin.
  const holder = () =>
    sessionHostHolder(input.authority({ computer: 'this computer', requester: { kind: 'cli' } }))
  const strip = <T extends { origin: SessionHostOrigin }>(request: T) => {
    const { origin, ...rest } = request
    return { rest, authority: input.authority(origin) }
  }
  return {
    hostId: service.identity.hostId,
    label: input.label,
    observe: async (params = {}) =>
      read(SessionHostObserveReplySchema, await service.observe(params)),
    execute: async (request: SessionHostRequest) => {
      const { rest, authority } = strip(request)
      const sent = rest as SessionHostExecutionRequest
      return read(SessionHostExecuteReplySchema, await service.execute(sent, authority))
    },
    reserve: async (request: SessionHostRequest) => {
      const { rest, authority } = strip(request)
      const sent = rest as SessionHostExecutionRequest
      return read(SessionHostExecuteReplySchema, await service.reserve(sent, authority))
    },
    release: async (params) => {
      const { rest, authority } = strip(params)
      return read(SessionHostExecuteReplySchema, await service.release(rest, authority))
    },
    operation: async (params) => read(SessionHostOperationReplySchema, service.operation(params)),
    relocationBundleRead: async (params) =>
      read(
        SessionHostBundleReadReplySchema,
        await readRelocationBundleChunk(service.store, params, holder())
      ),
    relocationBundleWrite: async (params) =>
      read(
        SessionHostBundleWriteReplySchema,
        await writeRelocationBundleChunk(service.store, params, holder())
      )
  }
}

/** Another computer, through its negotiated client; `hostId` is what its negotiation named. */
export function sessionHostClientPort(
  client: SessionHostClient,
  host: { hostId: string; label: string }
): SessionTransferHostPort {
  return {
    ...host,
    observe: (params) => client.observe(params),
    execute: (request) => client.execute(request),
    reserve: (request) => client.reserve(request),
    release: (params) => client.release(params),
    operation: (params) => client.operation(params),
    relocationBundleRead: (params) => client.relocationBundleRead(params),
    relocationBundleWrite: (params) => client.relocationBundleWrite(params)
  }
}

const TERMINAL = new Set(['completed', 'refused', 'unconfirmed'])

export type HostStepOutcome =
  /** Recorded and finished (or, for a reserve, admitted and holding). */
  | { kind: 'recorded'; operation: SessionHostReceivedOperation }
  /** Refused at the gate: nothing was recorded or sent. */
  | { kind: 'refused'; refusal: SessionHostReceivedRefusal }
  /** Still running there when this computer stopped waiting; query it again, never resend. */
  | { kind: 'running'; operation: SessionHostReceivedOperation }
  /** The host could not be asked or did not answer: the outcome is unknown. */
  | { kind: 'unreachable'; refusal: SessionHostReceivedRefusal }

export type HostStepOptions = {
  /** How long to keep asking about a dispatched step (a brief can take minutes). */
  waitMs: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

function isLost(reply: { status: string; refusal?: { code: string } }): boolean {
  return (
    reply.status === 'refused' &&
    (reply.refusal?.code === 'host-unreachable' || reply.refusal?.code === 'renegotiate')
  )
}

/**
 * Sends one step and follows it to its recorded end. A lost reply is followed by `operation`;
 * `found: false` from a reachable host is positive evidence it never arrived, so the IDENTICAL
 * request is sent again (the host dedupes it by id either way). Nothing else is ever resent.
 */
export async function runHostStep(
  port: SessionTransferHostPort,
  kind: 'execute' | 'reserve',
  request: SessionHostRequest,
  options: HostStepOptions
): Promise<HostStepOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + options.waitMs
  const settledFor = (state: string) =>
    TERMINAL.has(state) || (kind === 'reserve' && state === 'admitted')
  let reply: SessionHostClientReply<{ status: 'ok'; operation: SessionHostReceivedOperation }> =
    await port[kind](request)
  for (let attempt = 0; ; attempt += 1) {
    if (reply.status === 'ok') {
      if (settledFor(reply.operation.state)) {
        return { kind: 'recorded', operation: reply.operation }
      }
    } else if (!isLost(reply)) {
      return { kind: 'refused', refusal: reply.refusal }
    }
    if (options.signal?.aborted || now() >= deadline) {
      return reply.status === 'ok'
        ? { kind: 'running', operation: reply.operation }
        : { kind: 'unreachable', refusal: reply.refusal }
    }
    if (attempt > 0 || reply.status === 'ok') {
      await sleep(options.pollMs ?? 2_000)
    }
    const asked = await port.operation({
      operationId: request.operationId,
      conversationId: request.conversationId
    })
    if (asked.status === 'ok' && asked.found) {
      reply = { status: 'ok', operation: asked.operation }
    } else if (asked.status === 'ok') {
      reply = await port[kind](request)
    } else if (!isLost(asked)) {
      return { kind: 'refused', refusal: asked.refusal }
    } else {
      reply = asked
    }
  }
}
