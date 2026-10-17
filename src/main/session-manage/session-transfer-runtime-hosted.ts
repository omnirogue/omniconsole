/**
 * The hosted-source half of `session handoff` / `consolidate` on this computer. A source this
 * computer's own session host has adopted is reserved, asked and settled through that host (in
 * process), exactly as a source on another computer is through its host, but only once the host
 * carries transfers. Until then every source stays on the existing path unchanged.
 */

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY } from '../../shared/session-host-capabilities'
import { sessionHostConversationId, sessionHostDigest } from '../../shared/session-host-identity'
import type { SessionHostAuthority, SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS } from '../runtime/rpc/methods/session-manage-schemas'
import { findSessionHostRegistration } from '../session-host/session-host-ownership-registry'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import type { TransferSession } from './session-manage-transfer-contract'
import type { SessionTransferHostedDeps } from './session-transfer-hosted-sources'
import { inProcessSessionTransferHostPort } from './session-transfer-host-port'
import { fileSessionTransferRecords } from './session-transfer-record-files'
import type { HostTransferSource, SessionTransferHostRecord } from './session-transfer-host-sources'

function originOf(actor: SessionManageActor): SessionHostOrigin {
  const computer = hostname()
  return actor.kind === 'pane'
    ? { computer, requester: { kind: 'pane', paneKey: actor.paneKey, title: actor.title } }
    : { computer, requester: { kind: 'cli' } }
}

/** Null when this computer has no session host, or its host does not carry transfers yet. */
async function transferHost() {
  const service = await activeRuntimeSessionHost()
    ?.serviceIfPresent()
    .catch(() => null)
  return service?.capabilities().includes(SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY)
    ? service
    : null
}

type LocalAuthorityActor = Extract<SessionHostAuthority, { kind: 'local' }>['actor']

/** Another computer's authority is never relabelled as this computer's own. */
export function localTransferActor(actor: SessionManageActor): LocalAuthorityActor | null {
  return actor.kind === 'remote' ? null : actor
}

export function runtimeTransferHostedDeps(
  actor: SessionManageActor,
  signal?: AbortSignal
): SessionTransferHostedDeps {
  const local = localTransferActor(actor)
  const conversationOf = async (session: TransferSession): Promise<string | null> => {
    const journal = (await transferHost())?.store.snapshot()
    const registration =
      journal && session.source ? findSessionHostRegistration(journal, session.source) : null
    return registration?.adopted ? registration.conversationId : null
  }
  return {
    records: fileSessionTransferRecords<SessionTransferHostRecord>(
      join(getProfileUserDataPath(), 'session-transfers'),
      (record) => record.transfer
    ),
    mintOperationId: () => `${Date.now()}-${randomBytes(16).toString('hex')}`,
    now: Date.now,
    // Why this long: a brief is a whole turn, and a lost reply is followed until it settles.
    step: { waitMs: SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS + 60_000, ...(signal ? { signal } : {}) },
    origin: originOf(actor),
    targetHostId: async () => {
      const service = await activeRuntimeSessionHost()?.service()
      if (!service) {
        throw new Error('This computer has no session host to receive the work.')
      }
      return service.identity.hostId
    },
    // Why a digest when unregistered: the receipt names the target; it grants nothing.
    targetConversationId: async (target) =>
      (await conversationOf(target)) ??
      sessionHostConversationId(
        sessionHostDigest(`${target.row.worktreeId}\u0000${target.row.viewKey}`).slice(7, 39)
      ),
    hostedFor: async (session): Promise<HostTransferSource | null> => {
      const service = local ? await transferHost() : null
      const conversationId = service ? await conversationOf(session) : null
      return service && local && conversationId
        ? {
            port: inProcessSessionTransferHostPort(service, {
              label: 'this computer',
              authority: () => ({ kind: 'local', actor: local })
            }),
            conversationId,
            title: session.entry.title
          }
        : null
    }
  }
}
