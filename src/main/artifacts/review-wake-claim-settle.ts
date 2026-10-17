/**
 * How a claim this computer made ends (OAOS-12 Phase 2): released, retried until OmniOS confirms,
 * while nothing started; confirmed done once a terminal may run the session. Also what a later pass
 * or a restart finishes from the journal.
 */

import type {
  ClaimerHost,
  ClaimRecord,
  ReleaseReason,
  WakeClaimerDeps
} from './review-wake-claimer'

export async function release(
  deps: WakeClaimerDeps,
  slug: string,
  host: ClaimerHost,
  record: ClaimRecord,
  reason: ReleaseReason,
  why?: string
): Promise<void> {
  const released = await deps.release(slug, host, reason).catch(() => false)
  deps.writeClaim(slug, {
    ...record,
    phase: released ? 'failed' : 'releasing',
    release: reason,
    at: deps.now(),
    ...(why ? { reason: why } : {})
  })
}

export async function confirmDone(
  deps: WakeClaimerDeps,
  slug: string,
  host: ClaimerHost,
  record: ClaimRecord
): Promise<void> {
  deps.writeClaim(slug, { ...record, phase: 'moved', at: deps.now() })
  const done = await deps.done(slug, host).catch(() => ({ status: 'failed' as const }))
  // Why a refusal is final too: OmniOS answers the same next minute; the claim is ours either way.
  if (done.status === 'ok' || done.status === 'refused') {
    deps.writeClaim(slug, { ...record, phase: 'done', at: deps.now() })
  }
}

/** Finishes what an earlier pass or a crash left: release what never ran, confirm what may have. */
export async function settleClaims(deps: WakeClaimerDeps, host: ClaimerHost): Promise<void> {
  for (const [slug, record] of Object.entries(deps.readClaims())) {
    if (record.phase === 'claiming' || record.phase === 'claimed' || record.phase === 'releasing') {
      await release(deps, slug, host, record, record.release ?? 'could not start')
      await deps.cleanup(slug, record.revision).catch(() => {})
    } else if (record.phase === 'launching' || record.phase === 'moved') {
      // Why done: a terminal may run it here, so the computer it slept on must give it up.
      await confirmDone(deps, slug, host, record)
      await deps.cleanup(slug, record.revision).catch(() => {})
      if (record.phase === 'launching') {
        deps.audit(
          { slug, revision: record.revision },
          `A restart interrupted the launch of conversation ${record.sessionId ?? ''} here; open it to check it runs.`
        )
      }
    }
  }
}
