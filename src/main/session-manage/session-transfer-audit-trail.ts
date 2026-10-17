/**
 * A transfer's result as it starts and as it completes, and its audit trail: every applied step is
 * audited with the actor and remembered, and an audit that cannot be written becomes a warning.
 */

import type { SessionTransferResult } from '../../shared/session-transfer-types'
import {
  transferIdentity,
  type SessionTransferDeps,
  type SessionTransferInput,
  type SessionTransferMode,
  type TransferAudit,
  type TransferSession
} from './session-manage-transfer-contract'

export function startTransferResult(
  input: SessionTransferInput,
  mode: SessionTransferMode
): SessionTransferResult {
  const { actor, dryRun, target } = input
  return {
    actor,
    dryRun,
    action: mode,
    target: target === 'new' ? { paneKey: null, title: 'new' } : transferIdentity(target),
    outcome: 'planned',
    sources: input.sources.map(transferIdentity),
    skipped: [],
    steps: [],
    summary: '',
    briefSent: false,
    archived: []
  }
}

export function transferAuditTrail(
  deps: Pick<SessionTransferDeps, 'audit'>,
  input: Pick<SessionTransferInput, 'actor'>,
  mode: SessionTransferMode,
  result: SessionTransferResult
): { applied: string[]; audit: (record: Omit<TransferAudit, 'actor'>) => Promise<void> } {
  const applied: string[] = []
  const audit = async (record: Omit<TransferAudit, 'actor'>): Promise<void> => {
    if (record.action !== mode) {
      applied.push(record.summary)
    }
    const warning = await Promise.resolve()
      .then(() => deps.audit({ ...record, actor: input.actor }))
      .catch(
        (error: unknown) =>
          `The action ran, but its audit could not be written: ${error instanceof Error ? error.message : String(error)}`
      )
    if (warning) {
      result.auditError = [result.auditError, warning].filter(Boolean).join('\n')
    }
  }
  return { applied, audit }
}

export function transferAbortCheck(signal: AbortSignal | undefined): () => void {
  return () => {
    if (signal?.aborted) {
      throw new Error('The caller stopped waiting.')
    }
  }
}

/** Sources archived here are counted; hosted ones get their own receipts after this. */
export function transferCompletedSummary(
  mode: SessionTransferMode,
  target: TransferSession,
  where: string,
  archivedHere: number,
  adopted: string | null
): string {
  const verb = mode === 'handoff' ? 'Handed off' : 'Consolidated'
  const archived = archivedHere
    ? `; archived ${archivedHere} source${archivedHere === 1 ? '' : 's'} after acknowledgement`
    : ' after acknowledgement'
  return `${verb} into “${target.entry.title}”${where}${archived}${adopted ? `; ${adopted}` : ''}.`
}
