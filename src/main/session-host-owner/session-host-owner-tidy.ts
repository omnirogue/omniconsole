/**
 * `sessionHost.tidy`: session-manage's own tidy plan over the sessions this host runs, where each
 * archive it applies is its own admitted, turn-fenced `archive` operation through the owner
 * service. Operation ids derive from the tidy's own id, so a retried tidy replays every archive
 * instead of admitting it twice. An unattended caller's archives each pass Tier 2 at dispatch.
 */

import type { SessionHostAuthority } from '../../shared/session-host-authority'
import { isUnattendedSessionHostAuthority } from '../../shared/session-host-authority'
import { sessionHostDigest } from '../../shared/session-host-identity'
import type {
  SessionHostTidyParams,
  SessionHostTidyResult,
  SessionHostTidyRow
} from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { findSessionHostRegistration } from '../session-host/session-host-ownership-registry'
import type { SessionHostService } from '../session-host/session-host-service'
import { planSessionTidy } from '../session-manage/session-manage-tidy'
import type { AnswerWaitSession } from '../answer-delivery/answer-wait'
import type { HostSessionInventory } from './host-session-inventory'

export type OwnerTidyDeps = {
  inventory: HostSessionInventory
  service(): SessionHostService | null
  holdFor(row: Pick<SessionManageSidebarRow, 'rowKey' | 'paneKey' | 'worktreeId'>): string | null
  /** Read once per tidy: why a decision or a Question still waits on a session (it is kept). */
  answerWait?(): (session: AnswerWaitSession) => string | null
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
}

/** Same epoch as the tidy's own id, entropy from it and the conversation: stable across retries. */
export function tidyArchiveOperationId(tidyOperationId: string, conversationId: string): string {
  const stamp = tidyOperationId.slice(0, 13)
  const entropy = sessionHostDigest(`session-host-tidy/v1\n${tidyOperationId}\n${conversationId}`)
  return `${stamp}-${entropy.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

export async function hostTidy(
  deps: OwnerTidyDeps,
  params: SessionHostTidyParams,
  authority: SessionHostAuthority
): Promise<SessionHostTidyResult> {
  const service = deps.service()
  const journal = service?.store.snapshot()
  if (!service || !journal) {
    return {
      status: 'refused',
      refusal: sessionHostRefusal(
        'storage-unavailable',
        "That computer's session records are unreadable."
      )
    }
  }
  const sessions = await deps.inventory.list()
  const registrations = new Map<string, SessionHostRegistration>()
  for (const session of sessions) {
    const registration = session.source
      ? findSessionHostRegistration(journal, session.source)
      : null
    if (registration && session.entry.paneKey) {
      registrations.set(session.entry.paneKey, registration)
    }
  }
  // Why a person only: an automatic tidy never archives what a hold keeps.
  const include = new Set(
    isUnattendedSessionHostAuthority(authority)
      ? []
      : [...registrations]
          .filter(([, registration]) => params.include?.includes(registration.conversationId))
          .map(([paneKey]) => paneKey)
  )
  const plan = planSessionTidy(
    sessions,
    deps.holdFor,
    include,
    deps.answerWait ? { answerWait: deps.answerWait() } : {}
  )
  const rows: SessionHostTidyRow[] = plan.rows.map((row) => ({
    conversationId: (row.paneKey && registrations.get(row.paneKey)?.conversationId) || null,
    title: row.title,
    // Why the cast is safe: this plan has no delete mode, so no row is ever `delete`.
    action: row.action as SessionHostTidyRow['action'],
    reason: row.reason
  }))
  if (!params.apply) {
    return { status: 'ok', host: service.identity, dryRun: true, rows }
  }
  for (const row of rows) {
    if (row.action !== 'archive') {
      continue
    }
    const registration = row.conversationId ? journal.conversations[row.conversationId] : undefined
    if (!registration) {
      Object.assign(row, {
        outcome: 'skipped',
        outcomeReason: 'This computer holds no record for it, so it was not archived.'
      })
      continue
    }
    const operationId = tidyArchiveOperationId(params.operationId, registration.conversationId)
    // Why read it back: a retried tidy reads newer revisions, which would not match its first request.
    const recorded = journal.operations[operationId]
    if (recorded) {
      Object.assign(row, {
        operationId,
        outcome: recorded.state === 'completed' ? 'archived' : 'failed',
        ...(recorded.refusal ? { outcomeReason: recorded.refusal.message } : {})
      })
      continue
    }
    const reading = await deps.readTurn(registration)
    const executed = await service.execute(
      {
        operationId,
        conversationId: registration.conversationId,
        expectedOwnerEpoch: registration.ownerEpoch,
        expectedTurnRevision: reading === 'unreadable' ? null : reading.turnRevision,
        ...(reading !== 'unreadable' && reading.organizationRevision
          ? { expectedOrganizationRevision: reading.organizationRevision }
          : {}),
        action: 'archive',
        payload: {}
      },
      authority
    )
    const operation = executed.status === 'ok' ? executed.operation : null
    Object.assign(row, {
      operationId,
      outcome: operation?.state === 'completed' ? 'archived' : 'failed',
      ...(operation?.state === 'completed'
        ? {}
        : {
            outcomeReason:
              (executed.status === 'refused' ? executed.refusal : operation?.refusal)?.message ??
              `It ended ${operation?.state ?? 'unrecorded'}.`
          })
    })
  }
  return { status: 'ok', host: service.identity, dryRun: false, rows }
}
