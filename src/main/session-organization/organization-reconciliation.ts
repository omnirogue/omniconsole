import type {
  OrganizationProbeAnswer,
  OrganizationRecord
} from '../../shared/session-organization-change'
import type { OrganizationChangeLedger } from './organization-change-ledger'

/** Asks the window whether each interrupted change's targets hold its value now. */
export type OrganizationProbe = (
  records: OrganizationRecord[]
) => Promise<OrganizationProbeAnswer[]>

export type OrganizationReconciliation = { applied: string[]; failed: string[]; pending: number }

/**
 * Settles the changes a crash left prepared: applied (`reconciled: true`) when the window
 * confirms the value, else `failed: interrupted`. With no window to ask, they stay pending:
 * no ownership and no Undo until a window answers.
 */
export async function reconcileInterruptedChanges(
  ledger: Pick<OrganizationChangeLedger, 'ready' | 'pending' | 'resolveInterrupted'>,
  probe: OrganizationProbe
): Promise<OrganizationReconciliation> {
  await ledger.ready
  const pending = ledger.pending()
  if (pending.length === 0) {
    return { applied: [], failed: [], pending: 0 }
  }
  let answers: OrganizationProbeAnswer[]
  try {
    answers = await probe(pending)
  } catch (error) {
    console.warn(
      '[session-organization] interrupted changes stay pending: the window did not answer',
      error
    )
    return { applied: [], failed: [], pending: pending.length }
  }
  const byOpId = new Map(answers.map((answer) => [answer.opId, answer]))
  const applied: string[] = []
  const failed: string[] = []
  for (const record of pending) {
    const settled = await ledger.resolveInterrupted(record.opId, byOpId.get(record.opId))
    if (settled?.phase === 'applied') {
      applied.push(record.opId)
    } else if (settled) {
      failed.push(record.opId)
    }
  }
  return { applied, failed, pending: ledger.pending().length }
}
