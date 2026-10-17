/**
 * The checks an unattended action needs from the steward itself: its prompt limits before a Yes,
 * nudge or question is queued (D4), and Tier 2 eligibility before an archive (D3). WP-S2 provides
 * both through `setStewardPolicyHooks`; until it does, every such action is refused.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type {
  SessionManageActor,
  SessionManageEntry,
  SessionManageUnattended,
  SessionTidyResult,
  SessionTidyRow
} from '../../shared/session-manage-types'
import type {
  OrganizationChange,
  OrganizationChangeKind,
  OrganizationExecutor,
  OrganizationTarget
} from '../../shared/session-organization-change'
import type { SessionActionRecord } from './session-actions-log'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import { remoteExecutionRefusal } from './session-manage-locality'
import { SessionManageRefusal } from './session-manage-refusal'
import {
  assertUnattendedPolicy,
  stewardArchiveSwitchRefusal,
  unattendedContextFor,
  type UnattendedAction
} from './session-manage-unattended'

export type StewardTier2Verdict = { ok: true; evidence: string } | { ok: false; reason: string }

/** Tier 2 eligibility of one archive target, asked just before it is archived (WP-S2). */
export type StewardTier2Check = (input: {
  target: OrganizationTarget
  context: SessionManageUnattended
  /** After the window applied the archive: the same rules again, the archived state aside. */
  recheck?: { granted: string }
  /** `close`: only the blank-session rule may grant it (absent reads as an archive). */
  action?: 'archive' | 'close'
}) => Promise<StewardTier2Verdict>

export type StewardPromptRequest = {
  context: SessionManageUnattended
  kind: 'yes' | 'prompt' | 'ask'
  entry: SessionManageEntry
  source: ConversationSource
  /** Exactly what would be queued, marker included. */
  text: string
}

/** Granted: `settle(true)` once queued, `settle(false)` when nothing went out. */
export type StewardPromptGrant =
  | { ok: true; settle?: (queued: boolean) => void }
  | { ok: false; reason: string }

/** The steward's per-session caps (WP-S2). */
export type StewardPromptBudget = (request: StewardPromptRequest) => Promise<StewardPromptGrant>

export type StewardPolicyHooks = {
  tier2Eligibility?: StewardTier2Check
  promptBudget?: StewardPromptBudget
}

export const STEWARD_TIER2_UNAVAILABLE =
  'the steward’s finished-session check (Tier 2) is not running on this computer'
export const STEWARD_PROMPT_LIMITS_UNAVAILABLE =
  'The steward’s prompt limits are not running on this computer'

const EVIDENCE_MAX = 1000

let hooks: StewardPolicyHooks = {}

/** Returns the restore; later registrations replace only the hooks they name. */
export function setStewardPolicyHooks(next: StewardPolicyHooks): () => void {
  const previous = hooks
  hooks = { ...hooks, ...next }
  return () => {
    hooks = previous
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** The switches first, then WP-S2's check; a missing or failing check never archives. */
export async function stewardTier2Verdict(
  context: SessionManageUnattended,
  target: OrganizationTarget,
  recheck?: { granted: string },
  action: 'archive' | 'close' = 'archive'
): Promise<StewardTier2Verdict> {
  const off = stewardArchiveSwitchRefusal()
  if (off) {
    return { ok: false, reason: off }
  }
  const check = hooks.tier2Eligibility
  if (!check) {
    return { ok: false, reason: STEWARD_TIER2_UNAVAILABLE }
  }
  try {
    return await check({
      target,
      context,
      ...(recheck ? { recheck } : {}),
      ...(action === 'close' ? { action } : {})
    })
  } catch (error) {
    return { ok: false, reason: `the finished-session check failed (${message(error)})` }
  }
}

function unattendedActionOf(
  change: Pick<OrganizationChange, 'kind' | 'value' | 'values'>
): UnattendedAction {
  const kind: OrganizationChangeKind = change.kind
  if (kind === 'archive') {
    const values = change.values ?? [change.value]
    return values.every((value) => value === true) ? 'archive' : 'folder-change'
  }
  if (kind === 'delete' && (change.values ?? [change.value]).every((value) => value === true)) {
    return 'close'
  }
  if (kind === 'title') {
    return 'rename'
  }
  const organize = ['tag', 'untag', 'hide', 'unhide', 'snooze']
  return organize.includes(kind) ? 'organize' : 'folder-change'
}

/**
 * An organization change by an unattended actor: an archive of sessions that each pass Tier 2
 * now, or the rules loop's close of a blank session its own rule passes now. Returns the evidence
 * to record, null when a person is behind it; throws a refusal (nothing changed) otherwise.
 */
export async function admitUnattendedOrganization(
  actor: SessionManageActor,
  change: Pick<OrganizationChange, 'kind' | 'value' | 'values' | 'targets'>,
  recheck?: { granted: string }
): Promise<string | null> {
  const action = unattendedActionOf(change)
  const context = assertUnattendedPolicy(actor, action)
  if (!context) {
    return null
  }
  const evidence: string[] = []
  const close = action === 'close'
  for (const target of change.targets) {
    const verdict = await stewardTier2Verdict(context, target, recheck, close ? 'close' : 'archive')
    if (!verdict.ok) {
      throw new SessionManageRefusal(
        sentence(`Not ${close ? 'closed' : 'archived'} by a steward run: ${verdict.reason}`)
      )
    }
    evidence.push(verdict.evidence)
  }
  return evidence.join('; ').slice(0, EVIDENCE_MAX)
}

/**
 * The same admission again at the settle boundary, after the window applied the change: null
 * while the granting rule still holds on what main can see (queue, held or delivered prompt,
 * state, activity, holds), otherwise why the row must be put back.
 */
export async function recheckUnattendedOrganization(
  actor: SessionManageActor,
  change: Pick<OrganizationChange, 'kind' | 'value' | 'values' | 'targets'>,
  evidence: string
): Promise<string | null> {
  try {
    await admitUnattendedOrganization(actor, change, { granted: evidence })
    return null
  } catch (error) {
    return message(error)
  }
}

/** Who stands behind a change main relays: the steward, or a pane or CLI the audit names. */
export function actorOfExecutor(
  executor: OrganizationExecutor,
  audit?: Pick<SessionActionRecord, 'steward' | 'unattended'>
): SessionManageActor | null {
  if (executor.kind === 'app' && executor.feature === 'steward') {
    const steward = audit?.steward
    if (steward?.feature === 'suggestion') {
      // Why an empty id still maps here: it is never being accepted, so it reads as unattended.
      return { kind: 'steward', feature: 'suggestion', suggestionId: steward.suggestionId ?? '' }
    }
    return { kind: 'steward', feature: steward?.feature ?? 'rules' }
  }
  const unattended = audit?.unattended ? { unattended: audit.unattended } : {}
  if (executor.kind === 'pane') {
    return { kind: 'pane', paneKey: executor.paneKey, title: executor.title, ...unattended }
  }
  return executor.kind === 'cli' ? { kind: 'cli', ...unattended } : null
}

/**
 * Queues a steward prompt only inside WP-S2's limits, and with Keep going refused rather than
 * stopped; anything a person is behind is relayed unchanged.
 */
export async function withUnattendedPrompt<T>(
  deps: SessionDeliveryDeps,
  actor: SessionManageActor,
  request: Omit<StewardPromptRequest, 'context'>,
  relay: (deps: SessionDeliveryDeps) => Promise<T>
): Promise<T> {
  const context = unattendedContextFor(actor)
  if (!context) {
    return relay(deps)
  }
  let grant: StewardPromptGrant
  try {
    grant = hooks.promptBudget
      ? await hooks.promptBudget({ ...request, context })
      : { ok: false, reason: STEWARD_PROMPT_LIMITS_UNAVAILABLE }
  } catch (error) {
    grant = {
      ok: false,
      reason: `The steward’s prompt limits could not be read (${message(error)}).`
    }
  }
  if (!grant.ok) {
    throw new SessionManageRefusal(`${sentence(grant.reason)} Nothing was sent.`)
  }
  const guarded: SessionDeliveryDeps = {
    ...deps,
    // Why refuse instead of stop: the steward never takes over work that already has a driver.
    stopKeepGoing: (source) => {
      if (deps.keepGoingOn?.(source) !== false) {
        throw new SessionManageRefusal(
          `“${request.entry.title}” is driven by Keep going (or it could not be read); a steward run never turns it off. Nothing was sent.`
        )
      }
      return false
    }
  }
  try {
    const result = await relay(guarded)
    grant.settle?.(true)
    return result
  } catch (error) {
    grant.settle?.(false)
    throw error
  }
}

/**
 * `session tidy` run by an unattended actor follows the Tier 2 rule, not the on-request rule:
 * an archive row stays one only when it passes Tier 2 now; the rest are held with the reason.
 */
export async function unattendedTidyPlan<P extends Pick<SessionTidyResult, 'rows' | 'counts'>>(
  plan: P,
  context: SessionManageUnattended
): Promise<P> {
  const rows: SessionTidyRow[] = []
  for (const row of plan.rows) {
    if (row.action !== 'archive') {
      rows.push(row)
      continue
    }
    // Why first: nothing the steward does reaches a session another computer runs (phase 4).
    const remote = remoteExecutionRefusal(row, 'tidy')
    const verdict: StewardTier2Verdict = remote
      ? { ok: false, reason: remote }
      : await stewardTier2Verdict(context, {
          ...(row.paneKey ? { paneKey: row.paneKey } : {}),
          ...(row.tabId ? { tabId: row.tabId } : {})
        })
    rows.push(
      verdict.ok
        ? row
        : {
            ...row,
            action: 'hold',
            reason: sentence(`Not archived by a steward run: ${verdict.reason}`)
          }
    )
  }
  const count = (action: SessionTidyRow['action']): number =>
    rows.filter((row) => row.action === action).length
  return {
    ...plan,
    rows,
    counts: { ...plan.counts, archive: count('archive'), hold: count('hold') }
  }
}
