/**
 * `omni session continue|ask|answer|stop|restart` on a session another computer runs: the
 * control goes to that computer, which carries it out on its own session (Phase 4 E). This Mac
 * refuses first what its own rules refuse: an unattended caller never reaches another computer
 * (S1; the host's own steward looks after its sessions), and a remote actor is never forwarded.
 * Everything the host refuses comes back in its own words, with nothing done here instead.
 */

import { hostname } from 'node:os'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageActor, SessionManageEntry } from '../../shared/session-manage-types'
import { parseSessionReference } from '../../shared/session-reference'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import { runRemoteSessionAction, type RemoteSessionOutcome } from './remote-session-action'
import type { RemoteSessionHosts } from './remote-session-hosts'

export type RemoteManageRequest =
  | { action: 'continue'; payload: SessionHostPayloads['continue'] }
  | { action: 'ask'; payload: SessionHostPayloads['ask'] }
  | { action: 'answer'; payload: SessionHostPayloads['answer'] }
  | { action: 'stop'; payload: SessionHostPayloads['stop'] }
  | { action: 'restart'; payload: SessionHostPayloads['restart'] }

export type RemoteManageDone = {
  outcome: Exclude<RemoteSessionOutcome, { kind: 'refused' }>
  summary: string
}

const VERB: Record<RemoteManageRequest['action'], string> = {
  continue: 'continue it',
  ask: 'ask it',
  answer: 'answer its question',
  stop: 'stop it',
  restart: 'restart it'
}

const KEEPS_EXISTING_STOP = new Set(['unsupported-capability', 'unknown-conversation'])

export function isRemoteSessionRow(row: Pick<SessionManageSidebarRow, 'hostId'>): boolean {
  const host = parseExecutionHostId(row.hostId)
  return host !== null && host.kind !== 'local'
}

export function remoteOrigin(
  actor: SessionManageActor,
  provenance: { request?: string; reason?: string },
  computer: string = hostname()
): SessionHostOrigin {
  if (actor.kind === 'steward' || actor.kind === 'remote' || actor.unattended) {
    // Why a throw, not a marked origin: S1 keeps an unattended caller on this computer's sessions.
    throw new SessionManageRefusal(
      'An automatic caller acts only on sessions this computer runs; the computer that runs this one looks after it with its own steward. Nothing was sent.'
    )
  }
  return {
    computer: computer.replace(/\.local$/i, '') || 'another computer',
    requester:
      actor.kind === 'pane'
        ? { kind: 'pane', paneKey: actor.paneKey, title: actor.title }
        : { kind: 'cli' },
    ...(provenance.request ? { request: provenance.request } : {}),
    ...(provenance.reason ? { reason: provenance.reason } : {})
  }
}

/** The host's refusal as this Mac says it: its words, plus what the retry rule means. */
export function remoteRefusalText(outcome: Extract<RemoteSessionOutcome, { kind: 'refused' }>) {
  const { refusal, retry } = outcome
  const hint =
    retry === 'new-operation-after-observe'
      ? ' The session moved on; list the sessions again before retrying.'
      : retry === 'repeat-same-operation' && outcome.operationId
        ? ` Its outcome is unknown (operation ${outcome.operationId}); nothing is resent automatically.`
        : ''
  return `${refusal.message}${hint}`
}

function summaryOf(
  outcome: RemoteManageDone['outcome'],
  title: string,
  action: RemoteManageRequest['action']
): string {
  const name = `“${title}”`
  switch (outcome.kind) {
    case 'would':
      return `Would ask the computer that runs ${name} to ${VERB[action]}.`
    case 'pending':
      return `Sent to the computer that runs ${name}; it has not confirmed yet (operation ${outcome.operationId}). It is never resent.`
    case 'completed': {
      const result = outcome.operation.result as { outcome?: unknown; reason?: unknown } | null
      if (result?.outcome === 'started_unconfirmed') {
        const reason = typeof result.reason === 'string' ? `: ${result.reason}` : ''
        return `The computer that runs ${name} started it again, but it is not confirmed${reason}. Check it before sending it anything.`
      }
      return `The computer that runs ${name} did it (${VERB[action]}).`
    }
  }
}

/**
 * Null for a session this computer runs: the caller's local path handles those unchanged. Stop is
 * the one control that already reached some remote sessions (an SSH pane's interrupt); where the
 * host offers no owner control, it keeps that path instead of a new refusal.
 */
export async function remoteSessionManage(input: {
  hosts: RemoteSessionHosts | null
  row: SessionManageSidebarRow
  entry: Pick<SessionManageEntry, 'title' | 'paneKey' | 'tabId' | 'ref'>
  actor: SessionManageActor
  request: RemoteManageRequest
  provenance: { request?: string; reason?: string }
  dryRun: boolean
}): Promise<RemoteManageDone | null> {
  if (!isRemoteSessionRow(input.row)) {
    return null
  }
  const origin = remoteOrigin(input.actor, input.provenance)
  const client = input.hosts ? await input.hosts.clientFor(input.row.hostId!) : null
  if (!input.hosts || !client) {
    throw new SessionManageRefusal(
      'This Mac cannot reach the session host of the computer that runs this session. Nothing was sent.'
    )
  }
  const outcome = await runRemoteSessionAction(
    {
      client,
      directory: input.hosts.directory,
      newOperationId: () => input.hosts!.newOperationId()
    },
    {
      connection: input.row.hostId!,
      target: {
        ...(input.row.ownerTarget ?? { paneKey: input.entry.paneKey, tabId: input.entry.tabId }),
        provider: providerOf(input.entry.ref)
      },
      action: input.request.action,
      payload: input.request.payload,
      origin,
      dryRun: input.dryRun
    }
  )
  if (outcome.kind === 'refused') {
    if (input.request.action === 'stop' && KEEPS_EXISTING_STOP.has(outcome.refusal.code)) {
      return null
    }
    throw new SessionManageRefusal(remoteRefusalText(outcome))
  }
  return { outcome, summary: summaryOf(outcome, input.entry.title, input.request.action) }
}

/** `claude:<id>@<host>` → the provider conversation the host registered. */
function providerOf(ref: string | null | undefined): { agent: string; sessionId: string } | null {
  const parsed = ref ? parseSessionReference(ref) : null
  return parsed ? { agent: parsed.agent, sessionId: parsed.sessionId } : null
}
