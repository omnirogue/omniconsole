// The person's choice for an item offered to an existing session (`sessionPrep.decideReuse`).

import type { SessionPrepReuseChoice } from '../../shared/session-prep-types'
import { launchSessionPrepItem, type SessionPrepLaunchContext } from './session-prep-launch'
import { SESSION_PREP_TERMINAL_ITEM, type SessionPrepBatchRecord } from './session-prep-records'
import { sessionPrepReuseDecisionError } from './session-prep-reuse'

export const SESSION_PREP_REUSE_HOLD_MS = 1_000

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * `skip` leaves it to the session already doing it (or editing its files). `assign` gives the prepared prompt to the offered session through `session assign` (which
 * re-checks it is still free; a refusal keeps the choice open with its reason). `launch` launches
 * exactly as if no session had been offered. `pump` then lets dependent items run.
 */
export async function applySessionPrepReuseChoice(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  index: number,
  choice: SessionPrepReuseChoice,
  pump: () => void
): Promise<void> {
  const item = batch.items.find((entry) => entry.index === index)
  const refusal = sessionPrepReuseDecisionError(item, choice)
  if (refusal) {
    throw new Error(refusal)
  }
  const reuse = item!.reuse!
  const prompt = item!.prompt!
  if (choice === 'launch') {
    // Why not back to 'planned': the pump would prepare it again from scratch.
    reuse.decided = 'launch'
    await ctx.persist()
    void launchSessionPrepItem(ctx, batch.id, index, prompt, item!.verdicts.at(-1) ?? null)
      .catch(async (error) => {
        if (!SESSION_PREP_TERMINAL_ITEM.has(item!.state)) {
          item!.state = 'failed'
          item!.note = reasonOf(error)
          await ctx.persist().catch(() => undefined)
        }
      })
      .finally(pump)
    return
  }
  if (choice === 'skip') {
    reuse.decided = 'skip'
    item!.state = 'already-covered'
    item!.note =
      reuse.kind === 'duplicate'
        ? `Not launched: already being done by “${reuse.title}”`
        : `Not launched: “${reuse.title}” is editing the same files`
    batch.updatedAt = ctx.now()
    await ctx.persist()
    pump()
    return
  }
  if (!ctx.reuse) {
    throw new Error('Giving a task to an existing session is not available here.')
  }
  reuse.decided = 'assign'
  delete reuse.failed
  // A delivery can outlive this process; resume must not offer the same task again.
  await ctx.persist()
  if (ctx.isCancelled(batch.id, index)) {
    return
  }
  // A delivered prompt cannot be undone; leave a cancellation window before sending.
  await new Promise((resolve) => setTimeout(resolve, SESSION_PREP_REUSE_HOLD_MS))
  if (ctx.isCancelled(batch.id, index)) {
    return
  }
  try {
    await ctx.reuse.assign({
      sourcePaneKey: batch.source.paneKey,
      owner: { paneKey: reuse.paneKey, tabId: reuse.tabId, ref: reuse.ref, cwd: reuse.cwd },
      prompt: item!.reusePrompt ?? prompt,
      request: batch.request,
      reason: `session prep: given to an existing session (${reuse.why}) instead of launching`
    })
    item!.state = 'assigned'
  } catch (error) {
    delete reuse.decided
    reuse.failed = reasonOf(error)
  }
  batch.updatedAt = ctx.now()
  await ctx.persist()
  if (item!.state === 'assigned') {
    pump()
  }
}
