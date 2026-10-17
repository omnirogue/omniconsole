/**
 * The Tier 2 step of a steward move: archive a finished session (or, in shadow mode, say it would),
 * keep one another session waits on with its result card saved so that wait can be met, and
 * remember finished sessions Tier 2 would not archive, for the pile-up count.
 */

import { stewardFeatureMode } from './steward-switches'
import {
  readStewardTier2,
  saveStewardResultCard,
  type StewardTier2Reading
} from './steward-tier2-check'
import { STEWARD_TIER2_QUIET_MS } from './steward-tier2'
import { message, none, note, type StewardRow, type StewardRowOutcome } from './steward-row-context'

const LEFTOVER_QUIET_MS = 6 * 60 * 60_000

function trackLeftover(ctx: StewardRow, reading: StewardTier2Reading): void {
  const { input, verdict } = reading
  const last = input.lastActivityAt
  // Why not a waiter's hold: that session is finished and only waits to be picked up.
  const heldBack =
    !verdict.ok &&
    !reading.cardVerdict?.ok &&
    Boolean(input.row.doneArchivePolicy) &&
    last !== null &&
    ctx.now - last >= LEFTOVER_QUIET_MS &&
    !ctx.entry.pinned &&
    !ctx.entry.saved &&
    !ctx.row.autoArchiveKeep
  if (heldBack) {
    ctx.memory.leftovers.set(ctx.paneKey, {
      paneKey: ctx.paneKey,
      title: ctx.entry.title,
      kind: 'finished-held',
      reason: verdict.reason,
      since: last
    })
  } else {
    ctx.memory.leftovers.delete(ctx.paneKey)
  }
}

export async function stewardTier2Step(ctx: StewardRow): Promise<StewardRowOutcome> {
  const mode = stewardFeatureMode('tier2Archive')
  if (mode === 'off') {
    return none(ctx)
  }
  const reading = await readStewardTier2(ctx.deps.tier2, ctx.row, ctx.session)
  trackLeftover(ctx, reading)
  const { verdict, input } = reading
  if (!verdict.ok && reading.cardVerdict?.ok && mode === 'on') {
    const saved = await saveStewardResultCard(ctx.deps.tier2, ctx.row, reading, ctx.session.source)
    return note(
      ctx,
      'kept',
      saved.ok || saved.reason === verdict.reason
        ? `Kept “${ctx.entry.title}” for the session waiting on its result; its result card is saved.`
        : `Kept “${ctx.entry.title}” for the session waiting on it, but ${saved.reason}.`,
      true
    )
  }
  if (!verdict.ok) {
    const quietAt =
      input.lastActivityAt === null
        ? undefined
        : Math.max(input.lastActivityAt, input.row.doneArchivePolicy?.since ?? ctx.now) +
          (input.row.doneArchivePolicy?.delayMs ?? STEWARD_TIER2_QUIET_MS)
    return none(ctx, quietAt !== undefined && quietAt > ctx.now ? quietAt : undefined)
  }
  const title = `“${ctx.entry.title}”`
  if (mode === 'shadow') {
    return note(
      ctx,
      'would-archive',
      `Would archive ${title}: finished, not verified (${verdict.evidence}).`,
      true
    )
  }
  try {
    const summary = await ctx.deps.act.archive({
      paneKey: ctx.paneKey,
      tabId: ctx.entry.tabId,
      title: ctx.entry.title
    })
    ctx.memory.leftovers.delete(ctx.paneKey)
    return await note(ctx, 'archive', `${summary} ${verdict.evidence}.`)
  } catch (error) {
    return note(ctx, 'refused', `Did not archive ${title}: ${message(error)}`, true)
  }
}
