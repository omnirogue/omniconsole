/**
 * The rules loop's move for a session an SSH host runs, and the third rule's place in S1's
 * steward check (`steward-remote-blank-rule.ts`): the live close goes through the blank-session
 * step, an unreachable blank row is archived on this computer only.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import {
  STEWARD_UNREACHABLE_BLANK_EVIDENCE,
  STEWARD_UNREACHABLE_BLANK_REASON,
  UNREACHABLE_BLANK_ARCHIVE_MS
} from '../../shared/session-steward-unreachable-blank'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { StewardTier2Check } from '../session-manage/session-manage-unattended-admission'
import { findSessionManageRow } from '../session-manage/session-manage-inventory'
import { isUnreachableSshRow, stewardUnreachableBlankVerdict } from './steward-remote-blank-rule'
import { stewardEmptySessionStep } from './steward-row-empty'
import { message, none, note, type StewardRow, type StewardRowOutcome } from './steward-row-context'
import { sshTargetLastReachedAt } from './ssh-reachability-log'
import { stewardFeatureOn } from './steward-switches'
import { readStewardTier2, type StewardTier2Deps } from './steward-tier2-check'

/** The third rule, read now for one row (after the window filed it, with `recheck`). */
export async function stewardUnreachableBlankCheck(
  deps: StewardTier2Deps,
  row: Parameters<typeof stewardUnreachableBlankVerdict>[0]['row'],
  recheck?: { granted: string }
): Promise<ReturnType<typeof stewardUnreachableBlankVerdict>> {
  if (!stewardFeatureOn('emptySessionArchive')) {
    return { ok: false, reason: 'the blank-session rule is switched off' }
  }
  const observed = await deps.observe(row)
  const { input } = await readStewardTier2(deps, row, observed, true)
  const hook = row.paneKey ? (deps.lastHookRow?.(row.paneKey) ?? null) : null
  return stewardUnreachableBlankVerdict({
    row,
    input,
    hook,
    // Why unknown counts as waiting: a queue this computer cannot read is never read as empty.
    queued: deps.queuedPrompts ? deps.queuedPrompts(row) : 1,
    lastReachedAt: lastReachedAt(row),
    ...(recheck ? { recheck } : {})
  })
}

/**
 * S1's steward check with the third rule in front: an archive of a row on an unreachable SSH
 * host is judged by it alone (the others refuse what this computer cannot see), with the same
 * keystroke-and-queue gate around the judgment. Everything else goes to `inner` unchanged.
 */
export function withUnreachableBlankRule(
  inner: StewardTier2Check,
  deps: StewardTier2Deps
): StewardTier2Check {
  return async (request) => {
    const { target, recheck, action } = request
    // Why a recheck of another rule's grant goes on: the grant, not today's host, picks the rule.
    const otherGrant = recheck && !recheck.granted.includes(STEWARD_UNREACHABLE_BLANK_EVIDENCE)
    if (action === 'close' || otherGrant || (!target.paneKey && !target.tabId)) {
      return inner(request)
    }
    const row = findSessionManageRow(await deps.readRows(), {
      ...(target.paneKey ? { paneKey: target.paneKey } : {}),
      ...(target.tabId ? { tabId: target.tabId } : {})
    })
    if (row && recheck && !isUnreachableSshRow(row)) {
      return { ok: false, reason: 'its host is reachable again' }
    }
    if (!row || !isUnreachableSshRow(row)) {
      return inner(request)
    }
    // Why before any await, and again after the last: a prompt, keystroke or reconnect that
    // lands while the facts below are read is not in them.
    const generation = deps.mutationGeneration(row)
    const reached = lastReachedAt(row)
    const verdict = await stewardUnreachableBlankCheck(deps, row, recheck)
    if (!verdict.ok) {
      return verdict
    }
    return deps.mutationGeneration(row) !== generation
      ? { ok: false, reason: 'a prompt or keystroke reached it while it was being checked' }
      : lastReachedAt(row) !== reached
        ? { ok: false, reason: 'its host was reached while it was being checked' }
        : verdict
  }
}

function lastReachedAt(row: Pick<SessionManageSidebarRow, 'hostId'>): number | null {
  const host = parseExecutionHostId(row.hostId)
  return host?.kind === 'ssh' ? sshTargetLastReachedAt(host.targetId) : null
}

/** The rules loop's move for an SSH row: the live close, or the third rule's archive here only. */
export async function stewardRemoteBlankStep(ctx: StewardRow): Promise<StewardRowOutcome | null> {
  if (!isUnreachableSshRow(ctx.row)) {
    return stewardEmptySessionStep(ctx)
  }
  const verdict = await stewardUnreachableBlankCheck(ctx.deps.tier2, ctx.row)
  if (!verdict.ok) {
    const clock = ctx.row.unreachableBlankPolicy
    return clock && ctx.now < clock.since + UNREACHABLE_BLANK_ARCHIVE_MS
      ? none(ctx, clock.since + UNREACHABLE_BLANK_ARCHIVE_MS)
      : none(ctx)
  }
  const title = ctx.entry.title
  try {
    const summary = await ctx.deps.act.archive(
      { paneKey: ctx.paneKey, tabId: ctx.row.tabId, title },
      STEWARD_UNREACHABLE_BLANK_REASON
    )
    return await note(ctx, 'archive', `${summary} (${verdict.evidence})`)
  } catch (error) {
    return note(ctx, 'refused', `Did not archive “${title}”: ${message(error)}`, true)
  }
}
