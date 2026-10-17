/**
 * The rules loop's blank-session move: a session nobody asked anything is closed (or, with the
 * archive action, archived) once it has been quiet long enough, or at once when its agent already
 * exited. It runs before the finished/unclear/work-left readings, which a blank session never
 * has; a session a person prompted goes on to them unchanged.
 */

import { stewardSettings, stewardFeatureOn } from './steward-switches'
import {
  isBlankReading,
  STEWARD_EMPTY_SESSION_REASON,
  stewardEmptySessionCheck
} from './steward-empty-session'
import { readStewardTier2 } from './steward-tier2-check'
import { message, none, note, type StewardRow, type StewardRowOutcome } from './steward-row-context'

/** Null when this is not a blank session (or the switch is off): the other rules decide. */
export async function stewardEmptySessionStep(ctx: StewardRow): Promise<StewardRowOutcome | null> {
  if (!stewardFeatureOn('emptySessionArchive') || !ctx.deps.tier2.personPrompted) {
    return null
  }
  const { emptySessionAction: action, emptySessionCloseMinutes } = stewardSettings()
  // Why before any read: whatever reaches it from here on must stop the close.
  const generation = ctx.deps.tier2.mutationGeneration(ctx.row)
  const prompted = await ctx.deps.tier2
    .personPrompted(ctx.row, ctx.session)
    .catch(() => 'unknown' as const)
  if (!isBlankReading(prompted, action)) {
    return null
  }
  const { input } = await readStewardTier2(ctx.deps.tier2, ctx.row, ctx.session, true)
  const verdict = await stewardEmptySessionCheck(
    ctx.deps.tier2,
    input,
    ctx.row,
    ctx.session,
    action
  )
  if (!verdict.ok) {
    const quietMs = emptySessionCloseMinutes * 60_000
    const since =
      input.lastActivityAt === null ? null : Math.max(input.lastActivityAt, ctx.row.lastSeenAt ?? 0)
    // Why a recheck: only the clock stands between it and the cleanup.
    return since !== null && ctx.now - since < quietMs ? none(ctx, since + quietMs) : none(ctx)
  }
  const target = {
    paneKey: ctx.paneKey,
    tabId: ctx.row.tabId,
    title: ctx.entry.title,
    worktreeId: ctx.row.worktreeId
  }
  const verb = action === 'close' ? 'close' : 'archive'
  try {
    const summary =
      action === 'close'
        ? await ctx.deps.act.close(target, {
            exited: ctx.entry.verdict === 'exited',
            unchanged: () => ctx.deps.tier2.mutationGeneration(ctx.row) === generation
          })
        : await ctx.deps.act.archive(target, STEWARD_EMPTY_SESSION_REASON)
    return await note(ctx, verb, `${summary} (${verdict.evidence})`)
  } catch (error) {
    return note(ctx, 'refused', `Did not ${verb} “${ctx.entry.title}”: ${message(error)}`, true)
  }
}
