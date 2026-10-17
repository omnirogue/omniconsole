import { doneArchiveEvidence } from '../../shared/session-done-archive'
import type { UpNextView } from '../../shared/up-next-types'
import { sessionLinksInText } from '../../shared/session-links'
import type { ArchiveReview } from './steward-archive-review'
/**
 * S1's `tier2Eligibility` hook: one archive target read and observed now, judged by the Tier 2
 * rules and bounded semantic review, with a result card saved before the archive is relayed.
 * Asked by the rules loop's own archives, by an automatic cleanup session's `session tidy`, and
 * again just before each archive, so every unattended archive is judged at that moment.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { StewardResultCard } from '../../shared/session-steward-status'
import type { OrganizationTarget } from '../../shared/session-organization-change'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'
import {
  findSessionManageRow,
  toSessionManageEntry
} from '../session-manage/session-manage-inventory'
import { remoteExecutionRefusal } from '../session-manage/session-manage-locality'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { sessionTidyHoldReason } from '../session-manage/session-manage-tidy'
import type {
  StewardTier2Check,
  StewardTier2Verdict
} from '../session-manage/session-manage-unattended-admission'
import type { StewardJev } from './steward-jev'
import { buildStewardResultCard, type StewardResultCardInput } from './steward-result-card'
import {
  stewardLastActivityAt,
  stewardTier2Blocker,
  stewardTier2Verdict,
  type StewardTier2Input
} from './steward-tier2'
import { sessionWaitersOf } from './steward-waiter-source'
import { stewardEmptySessionCheck, type StewardPersonPrompted } from './steward-empty-session'
import { stewardFeatureMode, stewardFeatureOn } from './steward-switches'
import { stewardArchiveRecheck } from './steward-archive-recheck'
import { isLiveSshRow, type StewardLastHookRow } from './steward-remote-blank-rule'

export type StewardCardFacts = Pick<
  StewardResultCardInput,
  'goal' | 'changed' | 'linkedDocs' | 'pullRequestFacts' | 'summary' | 'chains'
>

export type StewardTier2Deps = {
  readRows: () => Promise<SessionManageSidebarRow[]>
  readCompletion: (
    source: ConversationSource
  ) => Promise<Pick<UpNextView, 'finishReady' | 'archiveHasWork' | 'archiveProof'>>
  reviewArchive: (
    source: ConversationSource,
    goal: string | null,
    turn: SessionLatestTurn
  ) => Promise<ArchiveReview>
  observe: (row: SessionManageSidebarRow) => Promise<ObservedSession>
  chains: () => readonly SessionChain[]
  heldDelivery: (paneKey: string) => boolean
  /** The newest agent report this host holds for the pane, however old (an exited session). */
  lastHookAt: (paneKey: string) => number | null
  /** The newest change the person made to this session (move, rename, archive, Undo). */
  lastPersonActionAt: (viewKey: string) => Promise<number | null>
  /** What has reached the session (queue writes, keystrokes); synchronous, monotonic. */
  mutationGeneration: (row: SessionManageSidebarRow) => number
  latestTurn: (source: ConversationSource) => Promise<SessionLatestTurn>
  jev: StewardJev
  cardFacts: (
    row: SessionManageSidebarRow,
    source: ConversationSource | null,
    reply: string | null
  ) => Promise<StewardCardFacts>
  saveCard: (card: StewardResultCard) => Promise<void>
  /** The card already saved for a session, so one turn's card is built once. */
  readCard?: (key: string) => StewardResultCard | null
  /** The newest hook report this host holds for the pane (the third rule's empty start). */
  lastHookRow?: (paneKey: string) => StewardLastHookRow | null
  /** Whether a person has asked it anything (empty sessions); absent reads `unknown`. */
  personPrompted?: StewardPersonPrompted
  /** Prompts waiting in its queue, read even when its host cannot be reached (the third rule). */
  queuedPrompts?: (row: SessionManageSidebarRow) => number
  now: () => number
}

export type StewardTier2Reading = {
  input: StewardTier2Input
  verdict: StewardTier2Verdict
  /**
   * The same rules without the waiter check: a finished session another one waits on still gets
   * its result card, so that waiter's wait can be met, and is archived only once it has been.
   */
  cardVerdict: StewardTier2Verdict | null
  turn: SessionLatestTurn | null
}

/** Every fact Tier 2 reads; JEV is asked only when every rule before it holds. */
export async function readStewardTier2(
  deps: StewardTier2Deps,
  row: SessionManageSidebarRow,
  observed: ObservedSession,
  blockersOnly = false
): Promise<StewardTier2Reading> {
  const entry = toSessionManageEntry(observed)
  const { source } = observed
  const agentAt = entry.lastActivityAt ?? (row.paneKey ? deps.lastHookAt(row.paneKey) : null)
  const base: StewardTier2Input = {
    row,
    entry,
    hold: sessionTidyHoldReason(deps.chains(), row),
    waitedOnBy: sessionWaitersOf([
      row.paneKey,
      row.viewKey,
      row.rowKey,
      source ? conversationSourceRowKey(source) : null
    ]),
    heldDelivery: row.paneKey ? deps.heldDelivery(row.paneKey) : false,
    lastActivityAt: stewardLastActivityAt(agentAt, await deps.lastPersonActionAt(row.viewKey)),
    now: deps.now(),
    jevOff: null,
    doneness: null
  }
  if (blockersOnly || stewardTier2Blocker({ ...base, waitedOnBy: [] })) {
    return { input: base, verdict: stewardTier2Verdict(base), cardVerdict: null, turn: null }
  }
  const jevOff = deps.jev.offReason()
  const turn = source ? await deps.latestTurn(source) : null
  const doneness =
    !jevOff && source && turn?.known && turn.turnKey && turn.text
      ? await deps.jev.doneness({ source, turnKey: turn.turnKey, reply: turn.text })
      : null
  const input = { ...base, jevOff, doneness }
  return {
    input,
    verdict: stewardTier2Verdict(input),
    cardVerdict: stewardTier2Verdict({ ...input, waitedOnBy: [] }),
    turn
  }
}

function targetRow(
  rows: readonly SessionManageSidebarRow[],
  target: OrganizationTarget
): SessionManageSidebarRow | null {
  if (target.paneKey || target.tabId) {
    return findSessionManageRow(rows, {
      ...(target.paneKey ? { paneKey: target.paneKey } : {}),
      ...(target.tabId ? { tabId: target.tabId } : {})
    })
  }
  return target.sessionKey
    ? (rows.find((row) => !row.folded && row.viewKey === target.sessionKey) ?? null)
    : null
}

/**
 * Builds and saves the card of a finished session (once per turn), whether or not a waiter keeps
 * it from being archived; a card that could not be saved means no archive.
 */
export async function saveStewardResultCard(
  deps: Pick<StewardTier2Deps, 'cardFacts' | 'saveCard' | 'readCard' | 'now'>,
  row: SessionManageSidebarRow,
  reading: StewardTier2Reading,
  source: ConversationSource | null
): Promise<StewardTier2Verdict> {
  const card = reading.cardVerdict
  if (!card?.ok) {
    return reading.verdict
  }
  const turnKey = reading.turn?.turnKey ?? null
  const existing = deps.readCard?.(row.viewKey)
  if (turnKey && existing?.turnKey === turnKey) {
    return reading.verdict
  }
  try {
    const facts = await deps.cardFacts(row, source, reading.turn?.text ?? null)
    await deps.saveCard(
      buildStewardResultCard({
        ...facts,
        key: row.viewKey,
        paneKey: row.paneKey ?? row.viewKey,
        title: row.title,
        reply: reading.turn?.text ?? null,
        ...(turnKey ? { turnKey } : {}),
        evidence: card.evidence,
        now: deps.now()
      })
    )
  } catch (error) {
    return {
      ok: false,
      reason: `its result card could not be saved (${error instanceof Error ? error.message : String(error)})`
    }
  }
  return reading.verdict
}

/**
 * Tier 2's finished-session archive: the result card is saved first, then the owning host's
 * completion, a bounded JEV archive review and merged pull requests must all hold, and the Done
 * clock, completion and latest turn are read again just before the archive is allowed.
 */
async function stewardFinishedArchiveCheck(
  deps: StewardTier2Deps,
  target: OrganizationTarget,
  row: SessionManageSidebarRow,
  reading: StewardTier2Reading,
  observed: ObservedSession
): Promise<StewardTier2Verdict> {
  if (!reading.verdict.ok || !observed.source || !reading.turn || !row.doneArchivePolicy) {
    return saveStewardResultCard(deps, row, reading, observed.source)
  }
  const completion = await deps.readCompletion(observed.source)
  if (completion.finishReady !== true || completion.archiveHasWork !== false) {
    return { ok: false, reason: 'the owning host has unfinished or unverifiable work' }
  }
  const facts = await deps.cardFacts(row, observed.source, reading.turn.text)
  const review = await deps.reviewArchive(observed.source, facts.goal, reading.turn)
  if (!review) {
    return {
      ok: false,
      reason: 'the archive review is unavailable or leaves an unresolved obligation'
    }
  }
  if (review.kind === 'external-delivery' && !completion.archiveProof) {
    return {
      ok: false,
      reason: 'external delivery needs verified completion records; JEV cannot prove it'
    }
  }
  const refs = sessionLinksInText(reading.turn.text ?? '').flatMap((link) =>
    link.pullRequest ? [link.pullRequest] : []
  )
  if (
    refs.some(
      (ref) =>
        !facts.pullRequestFacts?.some(
          (fact) =>
            fact.owner.toLowerCase() === ref.owner.toLowerCase() &&
            fact.repo.toLowerCase() === ref.repo.toLowerCase() &&
            fact.number === ref.number &&
            fact.state === 'merged'
        )
    )
  ) {
    return { ok: false, reason: 'a referenced pull request is not merged' }
  }
  const evidence = `${doneArchiveEvidence(row.viewKey, row.doneArchivePolicy)} · Done delay ${row.doneArchivePolicy.delayMs}ms; ${review.evidence}; ${reading.verdict.evidence}`
  const reviewed = {
    ...reading,
    verdict: { ok: true as const, evidence },
    cardVerdict: { ok: true as const, evidence }
  }
  const saved = await saveStewardResultCard(deps, row, reviewed, observed.source)
  if (!saved.ok) {
    return saved
  }
  const freshRow = targetRow(await deps.readRows(), target)
  if (
    !freshRow ||
    freshRow.doneArchiveRevision !== row.doneArchiveRevision ||
    freshRow.doneArchivePolicy?.since !== row.doneArchivePolicy.since
  ) {
    return { ok: false, reason: 'the Done clock or attention changed during the review' }
  }
  const finalCompletion = await deps.readCompletion(observed.source)
  if (
    finalCompletion.finishReady !== true ||
    finalCompletion.archiveHasWork !== false ||
    finalCompletion.archiveProof !== completion.archiveProof
  ) {
    return { ok: false, reason: 'the owning host completion changed during the review' }
  }
  const fresh = await readStewardTier2(deps, freshRow, await deps.observe(freshRow))
  if (
    !fresh.verdict.ok ||
    fresh.turn?.turnKey !== reading.turn.turnKey ||
    fresh.turn.text !== reading.turn.text ||
    deps.jev.offReason()
  ) {
    return { ok: false, reason: 'the session changed during the archive review' }
  }
  return { ok: true, evidence }
}

/**
 * Either archive rule, each only while its own switch is on: a finished session (Tier 2, with its
 * result card saved first) or an empty one (nobody asked it anything). A close is the empty
 * rule's alone: the finished rule never ends an agent.
 */
export function createStewardTier2Check(deps: StewardTier2Deps): StewardTier2Check {
  return async ({ target, recheck, action }) => {
    const row = targetRow(await deps.readRows(), target)
    if (!row) {
      return { ok: false, reason: 'it is no longer in the sidebar' }
    }
    // Why first: nothing the steward does reaches a session another computer runs (phase 4).
    const remote = remoteExecutionRefusal(row, action === 'close' ? 'delete' : 'archive')
    // Why a live SSH close passes: the relay ends that pane, and only the blank rule may ask.
    if (remote && !(action === 'close' && isLiveSshRow(row))) {
      return { ok: false, reason: remote }
    }
    // Why before any await: a prompt or keystroke that lands while the facts below are being
    // read is not in them; the same counter is read again, synchronously, after the last await.
    const generation = deps.mutationGeneration(row)
    const verdict = await judge(deps, target, row, recheck, action === 'close')
    return verdict.ok && deps.mutationGeneration(row) !== generation
      ? { ok: false, reason: 'a prompt or keystroke reached it while it was being checked' }
      : verdict
  }
}

async function judge(
  deps: StewardTier2Deps,
  target: OrganizationTarget,
  row: SessionManageSidebarRow,
  recheck: { granted: string } | undefined,
  close: boolean
): Promise<StewardTier2Verdict> {
  const observed = await deps.observe(row)
  const reading = await readStewardTier2(deps, row, observed, close || recheck !== undefined)
  if (close) {
    return stewardEmptySessionCheck(deps, reading.input, row, observed, 'close')
  }
  if (recheck) {
    return stewardArchiveRecheck(deps, row, reading, observed, recheck.granted)
  }
  const refused: StewardTier2Verdict[] = []
  if (stewardFeatureMode('tier2Archive') === 'on') {
    const finished = await stewardFinishedArchiveCheck(deps, target, row, reading, observed)
    if (finished.ok) {
      return finished
    }
    refused.push(finished)
  }
  if (stewardFeatureOn('emptySessionArchive')) {
    const empty = await stewardEmptySessionCheck(deps, reading.input, row, observed, 'archive')
    if (empty.ok) {
      return empty
    }
    refused.push(empty)
  }
  return refused[0] ?? { ok: false, reason: 'no steward archive rule is switched on here' }
}
