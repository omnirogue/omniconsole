/**
 * The granting rule asked again at the settle boundary, after the window filed the row. The
 * window's rows now show it archived, with their Done and empty proofs cleared, so this reads
 * only what main itself can see change while an archive is in flight: a queued, held or
 * delivered prompt, the agent's state, new activity, a hold, a waiter, a pin. JEV is not asked
 * again, and the grant's evidence passes through unchanged when the rule still holds.
 */

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { DONE_ARCHIVE_DEFAULT_MINUTES } from '../../shared/session-done-archive'
import { STEWARD_EMPTY_SESSION_EVIDENCE } from '../../shared/session-steward-empty-session'
import type { StewardTier2Verdict } from '../session-manage/session-manage-unattended-admission'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { stewardEmptySessionVerdict, type StewardPromptedReading } from './steward-empty-session'
import { stewardFeatureMode, stewardFeatureOn, stewardSettings } from './steward-switches'
import { stewardTier2Blocker, type StewardTier2Input } from './steward-tier2'
import type { StewardTier2Deps, StewardTier2Reading } from './steward-tier2-check'

/** The Done delay the finished grant was given on; the default when an older grant omits it. */
function grantedDoneDelayMs(granted: string): number {
  const named = /Done delay (\d+)ms/.exec(granted)
  return named ? Number(named[1]) : DONE_ARCHIVE_DEFAULT_MINUTES * 60_000
}

export async function stewardArchiveRecheck(
  deps: Pick<StewardTier2Deps, 'personPrompted'>,
  filed: SessionManageSidebarRow,
  reading: StewardTier2Reading,
  observed: ObservedSession,
  granted: string
): Promise<StewardTier2Verdict> {
  // Why unfiled: the archive itself is the one change since the grant that must not count.
  const row = { ...filed, archived: false, archiveKind: null }
  const input: StewardTier2Input = {
    ...reading.input,
    row,
    entry: { ...reading.input.entry, archived: false }
  }
  if (granted.includes(STEWARD_EMPTY_SESSION_EVIDENCE)) {
    if (!stewardFeatureOn('emptySessionArchive')) {
      return { ok: false, reason: 'the empty-session rule was switched off' }
    }
    const prompted: StewardPromptedReading = deps.personPrompted
      ? await deps.personPrompted(row, observed).catch((): StewardPromptedReading => 'unknown')
      : 'unknown'
    const verdict = stewardEmptySessionVerdict({
      ...input,
      prompted,
      quietMs: stewardSettings().emptySessionCloseMinutes * 60_000,
      action: 'archive',
      agentForeground: observed.agentForeground,
      lastSeenAt: filed.lastSeenAt ?? null
    })
    return verdict.ok ? { ok: true, evidence: granted } : verdict
  }
  if (stewardFeatureMode('tier2Archive') !== 'on') {
    return { ok: false, reason: 'the finished-session rule was switched off' }
  }
  // Why a plain quiet rule: the window cleared the Done clock when it filed the row; new
  // activity inside the granted delay is what would make the grant stale.
  const blocker = stewardTier2Blocker(input, {
    ms: grantedDoneDelayMs(granted),
    needs: 'the Done delay it was archived on has not elapsed again'
  })
  return blocker ? { ok: false, reason: blocker } : { ok: true, evidence: granted }
}
