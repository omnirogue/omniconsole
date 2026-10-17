/**
 * Whether the account registry says this provider conversation was relinquished to another
 * computer and not relocated back: read from a journal snapshot, so a relay can ask it too.
 */

import type { SessionHostProviderIdentity } from '../../shared/session-host-identity'
import type { SessionHostJournal } from '../session-host/session-host-journal'

export function relocatedAwayIn(
  journal: SessionHostJournal | null | undefined,
  provider: SessionHostProviderIdentity
): { toHostId: string } | null {
  const same = Object.values(journal?.conversations ?? {}).filter(
    (registration) =>
      registration.provider.agent === provider.agent &&
      registration.provider.sessionId === provider.sessionId
  )
  // Why not when one is owned: a conversation relocated here again runs here again.
  const away = same.some((registration) => registration.owned)
    ? undefined
    : same.find((registration) => !registration.owned)
  const grantId = away?.relinquishment?.grantId
  // Why both keys: relinquishment writes its grant under `issued:<id>`.
  const toHostId = grantId
    ? (journal?.grants[`issued:${grantId}`] ?? journal?.grants[grantId])?.grant.toHostId
    : undefined
  return away ? { toHostId: toHostId ?? 'another computer' } : null
}
