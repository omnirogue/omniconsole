/**
 * `omni session relocate --pane <key> --to <host>`: move the same conversation to another computer
 * on a person's explicit request. This resolves the two hosts (this computer in process, another
 * through E's negotiated client), the conversation each host knows, the workspace on the
 * destination and who is asking, then runs the relocation over the hosts' own bundle calls. An
 * automatic caller only gets a proposal; renting or setting up a computer is never done here.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { parseSessionReference } from '../../shared/session-reference'
import type {
  SessionRelocateCommandParams,
  SessionRelocationResult
} from '../../shared/session-relocation-types'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { findRemoteObservation } from '../session-host-remote/remote-session-action'
import { remoteOrigin } from '../session-host-remote/remote-session-manage'
import { getRemoteSessionHosts } from '../session-host-remote/remote-session-hosts-runtime'
import { findSessionHostRegistration } from '../session-host/session-host-ownership-registry'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { SessionManageRefusal } from './session-manage-refusal'
import type { PreparedSessionAction } from '../runtime/rpc/methods/session-manage-support'
import {
  inProcessSessionTransferHostPort,
  sessionHostClientPort,
  type SessionTransferHostPort
} from './session-transfer-host-port'
import { relocateConversation } from './session-transfer-relocate'
import { sessionHostRelocationChannel } from './session-transfer-relocate-channel'
import { fileSessionRelocationRecords } from './session-transfer-relocate-record'
import { sessionRelocationEnabled } from './session-transfer-relocation-switch'
import { localProviderVersion } from './session-transfer-provider-version'
import { localTransferActor } from './session-transfer-runtime-hosted'

const THIS_COMPUTER = new Set(['local', 'this', 'here'])

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing was moved.`)
}

function hostKeyOf(value: string | null | undefined): string {
  const host = parseExecutionHostId(value)
  return !value || THIS_COMPUTER.has(value) || !host || host.kind === 'local' ? 'local' : value
}

/** This computer through its own host service; another through its negotiated client. */
async function portFor(
  hostKey: string,
  actor: SessionManageActor
): Promise<SessionTransferHostPort> {
  if (hostKey === 'local') {
    const local = localTransferActor(actor)
    const service = await activeRuntimeSessionHost()
      ?.service()
      .catch(() => null)
    if (!local || !service) {
      refuse('This computer has no session host to move conversations with.')
    }
    return inProcessSessionTransferHostPort(service, {
      label: 'this computer',
      authority: () => ({ kind: 'local', actor: local })
    })
  }
  const client = await getRemoteSessionHosts()?.clientFor(hostKey)
  const negotiation = client ? await client.negotiate() : null
  if (!client || !negotiation?.peer) {
    refuse(
      `${hostKey} could not be reached, or is not a computer this Mac knows (omni session hosts).`
    )
  }
  return sessionHostClientPort(client, { hostId: negotiation.peer.hostId, label: hostKey })
}

async function conversationOn(
  port: SessionTransferHostPort,
  hostKey: string,
  prepared: PreparedSessionAction
): Promise<string> {
  if (hostKey === 'local') {
    const journal = (
      await activeRuntimeSessionHost()
        ?.serviceIfPresent()
        .catch(() => null)
    )?.store.snapshot()
    const registration =
      journal && prepared.source ? findSessionHostRegistration(journal, prepared.source) : null
    if (!registration?.adopted) {
      refuse(
        `“${prepared.entry.title}” is not under this computer's session host yet, so it cannot move.`
      )
    }
    return registration.conversationId
  }
  const observed = await port.observe({})
  const reference = prepared.entry.ref ? parseSessionReference(prepared.entry.ref) : null
  const row =
    observed.status === 'ok'
      ? findRemoteObservation(observed.sessions, {
          paneKey: prepared.entry.paneKey,
          tabId: prepared.entry.tabId,
          provider: reference ? { agent: reference.agent, sessionId: reference.sessionId } : null
        })
      : null
  if (!row) {
    refuse(`${hostKey} does not list “${prepared.entry.title}” as a conversation it runs.`)
  }
  return row.conversationId
}

/** A person asks through the origin E builds; an automatic caller's origin only ever proposes. */
function relocationOrigin(
  actor: SessionManageActor,
  provenance: { reason?: string; request?: string }
): SessionHostOrigin {
  const unattended =
    actor.kind === 'steward'
      ? { source: actor.feature === 'cleanup-run' ? ('cleanup-run' as const) : ('rules' as const) }
      : actor.kind !== 'remote'
        ? actor.unattended
        : undefined
  if (actor.kind === 'remote') {
    refuse('Another computer cannot ask this one to move a conversation.')
  }
  if (!unattended) {
    return remoteOrigin(actor, provenance)
  }
  return { ...remoteOrigin({ kind: 'cli' }, provenance), requester: { kind: 'cli', unattended } }
}

/** A git workspace moves at the commit it runs here; anything else is the folder named. */
async function destinationWorkspace(
  prepared: PreparedSessionAction,
  params: SessionRelocateCommandParams
) {
  if (params.commit) {
    return { kind: 'git' as const, commit: params.commit, path: params.workspace }
  }
  const here = prepared.row.hostId === null || hostKeyOf(prepared.row.hostId) === 'local'
  const cwd = prepared.entry.worktreePath
  const head =
    here && cwd
      ? await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd }).then(
          ({ stdout }) => stdout.trim(),
          () => ''
        )
      : ''
  return /^[0-9a-f]{40}$/.test(head)
    ? { kind: 'git' as const, commit: head, path: params.workspace }
    : { kind: 'folder' as const, path: params.workspace }
}

export async function relocateFromCommand(input: {
  runtime: OrcaRuntimeService
  userDataPath: string
  prepared: PreparedSessionAction
  params: SessionRelocateCommandParams
  signal?: AbortSignal
}): Promise<SessionRelocationResult> {
  const { prepared, params } = input
  const { actor } = prepared
  const origin = relocationOrigin(actor, params)
  const from = hostKeyOf(prepared.row.hostId)
  const to = hostKeyOf(params.to)
  if (from === to) {
    refuse(`“${prepared.entry.title}” already runs on ${to === 'local' ? 'this computer' : to}.`)
  }
  // Why before any host is asked: a Mac opens an SSH host's terminals, so it cannot show one it resumed.
  if (parseExecutionHostId(to)?.kind === 'ssh') {
    refuse(
      `${to} is an SSH host, which cannot take a moved conversation yet. Move it to a Mac, or hand the work to a new session there (omni session handoff).`
    )
  }
  const source = await portFor(from, actor)
  const destination = await portFor(to, actor)
  const agent = prepared.entry.agent
  return await relocateConversation(
    {
      source,
      destination,
      channel: sessionHostRelocationChannel(),
      records: fileSessionRelocationRecords(join(input.userDataPath, 'session-relocations')),
      relocationEnabled: sessionRelocationEnabled,
      mintOperationId: () => `${Date.now()}-${randomBytes(16).toString('hex')}`,
      now: Date.now,
      step: { waitMs: 5 * 60_000, ...(input.signal ? { signal: input.signal } : {}) }
    },
    {
      conversationId: await conversationOn(source, from, prepared),
      origin,
      workspace: await destinationWorkspace(prepared, params),
      providerVersion:
        from === 'local' && (agent === 'claude' || agent === 'codex')
          ? ((await localProviderVersion(agent)) ?? 'unknown')
          : 'unknown',
      dryRun: params.dryRun === true,
      ...(params.relocation ? { relocation: params.relocation } : {})
    }
  )
}
