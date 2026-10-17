/**
 * Merge suggestions (Phase 3 §3, D5): two idle local sessions in one repo or top-level folder that
 * change the same files, or that JEV reads as the same deliverable in both orders, earn one
 * "Merge A into B?" suggestion. Nothing merges unless the person says Yes in Work; then the source
 * is handed off to the later-active session (brief, acknowledgement, adoption, archive).
 */

import type { SessionBatchOriginsSnapshot } from '../../../shared/session-batch-origin'
import type { SessionManageActor } from '../../../shared/session-manage-types'
import {
  organizationTargetKey,
  organizationValueAt,
  type OrganizationHistory,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  STEWARD_INDEPENDENT_TAG_ID,
  type StewardSuggestion
} from '../../../shared/session-steward-suggestions'
import type { DecisionRequest, DecisionResult } from '../../../shared/structured-decisions'
import { SESSION_OWNER_DUPLICATE_QUESTION } from '../../session-manage/session-manage-owner-jev'
import { fitJevText } from '../../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../../structured-decisions/typesafe-provider'
import { STEWARD_ORGANIZE_JEV_CAPABILITY, type StewardSessionFacts } from './steward-organize-jev'
import {
  STEWARD_REFILE_MIN,
  stewardPersonGoal,
  stewardSessionFacts,
  stewardSessionTarget,
  type StewardOrganizeDeps
} from './steward-refile'
import { stewardRowMayMove, type StewardOrganizeRow } from './steward-refile-candidates'
import type { StewardSuggestionAcceptor } from './steward-suggestion-accept'
import { stewardSuggestionPairKey } from './steward-suggestions-store'

/** Pairs looked at per pass; the JEV reads among them also spend the day's pair budget. */
const PAIRS_PER_PASS = 40

export type StewardMergeDeps = {
  /** Files both sessions' worktrees changed (`findSessionConflicts`); empty when unknown. */
  sharedFiles: (left: StewardOrganizeRow, right: StewardOrganizeRow) => Promise<string[]>
}

export type StewardMergeProposal = { from: OrganizationTarget; into: OrganizationTarget }

/** Merges one session into another as the accepting person; the transfer's summary. */
export type StewardConsolidate = (input: {
  actor: SessionManageActor
  request: string
  source: StewardOrganizeRow
  target: StewardOrganizeRow
}) => Promise<{ completed: boolean; summary: string }>

function describe(facts: StewardSessionFacts): string {
  return fitJevText(
    [
      `Title: ${facts.title}`,
      `Goal (the person's first request to it): ${facts.goal?.trim() || 'unknown'}`,
      `Repository: ${facts.repo ?? 'none'}`
    ].join('\n'),
    4_000
  )
}

function duplicateRequest(first: string, second: string): DecisionRequest {
  return {
    capability: STEWARD_ORGANIZE_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { first, second },
    questions: { duplicate: { type: 'noul', instructions: SESSION_OWNER_DUPLICATE_QUESTION } }
  }
}

function noul(result: DecisionResult | { failed: string }): number | null {
  if ('failed' in result) {
    return null
  }
  const answer = result.answers.duplicate
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null
}

/** "Same deliverable" in both orders, the lower kept; null when either order is missing. */
export async function readSameDeliverable(
  left: StewardSessionFacts,
  right: StewardSessionFacts,
  decide: StewardOrganizeDeps['decide']
): Promise<number | null> {
  const [first, second] = [describe(left), describe(right)]
  const [ordered, swapped] = await Promise.all([
    decide(duplicateRequest(first, second)),
    decide(duplicateRequest(second, first))
  ])
  const a = noul(ordered)
  const b = noul(swapped)
  return a === null || b === null ? null : Math.min(a, b)
}

function topLevel(path: string | null): string | null {
  return path ? (path.split(' / ')[0] ?? null) : null
}

/** Session prep marked it independent (a competing or reviewing session): never merged. */
function independent(
  observed: StewardOrganizeRow,
  origins: SessionBatchOriginsSnapshot | null
): boolean {
  return origins?.sessions[observed.row.viewKey]?.independent === true
}

/** The person tagged it `independent` (its latest tag record for that tag adds it). */
export function taggedIndependent(history: Pick<OrganizationHistory, 'key' | 'entries'>): boolean {
  for (const record of history.entries) {
    if (record.phase !== 'applied' || (record.kind !== 'tag' && record.kind !== 'untag')) {
      continue
    }
    const index = record.targets.findIndex(
      (target) => organizationTargetKey(target) === history.key
    )
    if (organizationValueAt(record, Math.max(index, 0)) === STEWARD_INDEPENDENT_TAG_ID) {
      return record.kind === 'tag'
    }
  }
  return false
}

function related(left: StewardOrganizeRow, right: StewardOrganizeRow): boolean {
  const repo = left.row.repoId !== null && left.row.repoId === right.row.repoId
  const folder = topLevel(left.row.folder)
  return repo || (folder !== null && folder === topLevel(right.row.folder))
}

/** One suggestion per related pair that duplicates work; returns the new or open suggestion ids. */
export async function proposeStewardMerges(
  deps: StewardOrganizeDeps & StewardMergeDeps,
  rows: readonly StewardOrganizeRow[],
  origins: SessionBatchOriginsSnapshot | null
): Promise<string[]> {
  if (deps.mode('mergeSuggestions') !== 'on') {
    return []
  }
  const sessions: StewardOrganizeRow[] = []
  for (const observed of rows) {
    if (
      stewardRowMayMove(observed) &&
      !independent(observed, origins) &&
      !taggedIndependent(await deps.history(observed.row.viewKey)) &&
      // Why: two sessions nobody has asked anything read as "the same", and merging asks one of
      // them for a handoff as its first prompt.
      (await stewardPersonGoal(deps, observed)) !== null
    ) {
      sessions.push(observed)
    }
  }
  const proposed: string[] = []
  let looked = 0
  for (const [i, left] of sessions.entries()) {
    for (const right of sessions.slice(i + 1)) {
      if (!related(left, right) || looked >= PAIRS_PER_PASS) {
        continue
      }
      looked += 1
      const targets = [stewardSessionTarget(left), stewardSessionTarget(right)]
      const pairKey = stewardSuggestionPairKey('merge', targets)
      if (
        deps.state.pair(pairKey) !== undefined ||
        (await deps.suggestions.wasDismissed(pairKey))
      ) {
        continue
      }
      const shared = await deps.sharedFiles(left, right).catch(() => [])
      let evidence: string
      if (shared.length > 0) {
        evidence = `${shared.length} shared file${shared.length === 1 ? '' : 's'}`
        deps.state.notePair(pairKey, 1)
      } else {
        if (!deps.state.spendPairRead(deps.pairReadsPerDay())) {
          return proposed
        }
        const value = await readSameDeliverable(
          await stewardSessionFacts(deps, left),
          await stewardSessionFacts(deps, right),
          deps.decide
        )
        deps.state.notePair(pairKey, value)
        if (value === null || value < STEWARD_REFILE_MIN) {
          continue
        }
        evidence = `Same deliverable (${value.toFixed(2)} both ways)`
      }
      // Why the later-active one: it holds the freshest context, so the other folds into it.
      const [source, target] =
        (left.entry.lastActivityAt ?? 0) > (right.entry.lastActivityAt ?? 0)
          ? [right, left]
          : [left, right]
      const suggestion = await deps.suggestions.propose({
        kind: 'merge',
        targets: [stewardSessionTarget(source), stewardSessionTarget(target)],
        proposal: {
          from: stewardSessionTarget(source),
          into: stewardSessionTarget(target)
        } satisfies StewardMergeProposal,
        title: `Merge “${source.row.title}” into “${target.row.title}”?`,
        evidence,
        pairKey
      })
      if (suggestion) {
        proposed.push(suggestion.id)
      }
    }
  }
  return proposed
}

function proposalOf(suggestion: StewardSuggestion): StewardMergeProposal {
  const value = suggestion.proposal as Partial<StewardMergeProposal> | null
  if (!value?.from || !value.into) {
    throw new Error('This merge suggestion is damaged. Nothing changed.')
  }
  return { from: value.from, into: value.into }
}

/** The Yes: merge the source into the target, archiving it only once the target adopted it. */
export function stewardMergeAcceptor(
  deps: Pick<StewardOrganizeDeps, 'rows' | 'goal'> & { consolidate: StewardConsolidate }
): StewardSuggestionAcceptor {
  return async (suggestion, { actor, request }) => {
    const { from, into } = proposalOf(suggestion)
    const rows = await deps.rows()
    const find = (target: OrganizationTarget) =>
      rows.find((observed) => observed.row.viewKey === organizationTargetKey(target))
    const source = find(from)
    const target = find(into)
    if (!source || !target || source.row.archived || target.row.archived) {
      throw new Error('One of these sessions is no longer open. Nothing changed.')
    }
    // Why re-check on Yes: a suggestion made before this rule, or before either was prompted.
    for (const session of [source, target]) {
      if (!(await stewardPersonGoal(deps, session))) {
        throw new Error(
          `“${session.row.title}” has not been asked anything yet, so there is nothing to merge. Nothing changed.`
        )
      }
    }
    const result = await deps.consolidate({ actor, request, source, target })
    if (!result.completed) {
      throw new Error(result.summary)
    }
    return { summary: result.summary }
  }
}
