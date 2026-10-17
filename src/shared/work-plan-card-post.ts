import { isBoardTaskId } from './board-task-id'
import type { SessionChain } from './session-chain-types'
import type { SessionOutcome, SessionOutcomeEvidence } from './session-outcome-types'

/** The hub's note evidence kinds (`team/notes.py` EVIDENCE_KINDS), narrowed to what a run produces. */
export type WorkPlanCardEvidenceKind = 'file' | 'pr' | 'commit' | 'url' | 'text'

export type WorkPlanCardEvidence = { kind: WorkPlanCardEvidenceKind; ref: string; label: string }

/** What the worker did with the estate knowledge. A `final_report` without one is refused. */
export type WorkPlanCardKnowledge = {
  op: 'searched' | 'added' | 'none'
  reason?: string
  id?: string
}

export type WorkPlanCardNote = {
  note: string
  note_kind: 'progress' | 'final_report'
  payload: {
    summary: string
    done: string[]
    next_action: string
    evidence: WorkPlanCardEvidence[]
    knowledge: WorkPlanCardKnowledge[]
  }
}

/** A row for `POST /api/team/tasks/{btk}/evidence` (`team/contracts.py` EVIDENCE_KINDS). */
export type WorkPlanTaskEvidenceRow = { kind: 'pr' | 'commit' | 'doc'; ref: string; title: string }

export type WorkPlanCardPost = {
  taskId: string
  note: WorkPlanCardNote
  evidence: WorkPlanTaskEvidenceRow[]
}

/** WP-2's recommender row, or nothing. Only its label crosses to the card. */
export type WorkPlanCardRecommendation = string | { label: string } | null | undefined

const SUMMARY_MAX = 200

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function taskIdOf(chain: SessionChain, outcome: SessionOutcome): string | null {
  // `taskRef` is the filing; `continuation.taskId` is admitted card execution. Either names the
  // card this run belongs to, and the invariant is that when both exist they are the same card.
  if (isBoardTaskId(outcome.taskRef?.taskId)) {
    return outcome.taskRef!.taskId
  }
  const continued = chain.outcomeSet?.continuation.taskId
  return isBoardTaskId(continued) ? continued : null
}

function labelOf(outcome: SessionOutcome, entry: SessionOutcomeEvidence): string {
  const condition = outcome.conditions.find((candidate) => candidate.id === entry.conditionId)
  return condition?.label ?? `${entry.kind}: ${entry.target}`
}

function noteEvidenceKind(entry: SessionOutcomeEvidence): WorkPlanCardEvidenceKind {
  if (entry.kind === 'file') {
    return 'file'
  }
  if (entry.kind === 'pr') {
    return 'pr'
  }
  if (entry.kind === 'merge') {
    return 'commit'
  }
  return /^https?:\/\//.test(entry.target) ? 'url' : 'text'
}

function taskEvidenceRow(
  outcome: SessionOutcome,
  entry: SessionOutcomeEvidence
): WorkPlanTaskEvidenceRow | null {
  const title = clip(labelOf(outcome, entry), 200)
  if (entry.kind === 'pr') {
    return { kind: 'pr', ref: entry.target, title }
  }
  if (entry.kind === 'merge') {
    return { kind: 'commit', ref: entry.version ?? entry.target, title }
  }
  // A delivered document is a doc row, referenced by the receipt the host actually holds:
  // `sha256:<hash>:<path>` names the bytes, not a path anyone can swap underneath it.
  return entry.kind === 'file' || entry.kind === 'report'
    ? { kind: 'doc', ref: entry.receipt, title }
    : null
}

/**
 * ONE note for `POST /api/team/tasks/{btk}/comment`, plus the `task_evidence` rows for
 * `POST /api/team/tasks/{btk}/evidence` (amendment r).
 *
 * Pure, and it never invents evidence: every row here exists because the execution host wrote a
 * receipt or spent a verdict. A satisfied Outcome files a `final_report` — done[] are the Done When
 * statements that actually have a receipt, next_action is the recommender's or the literal 'none',
 * and knowledge carries the one entry the hub requires. Anything else is `progress`, which the hub
 * accepts with an empty done[]. Returns null when no card is named: a standalone pursuit never
 * touches the hub.
 */
export function workPlanCardPost(
  chain: SessionChain,
  recommendation?: WorkPlanCardRecommendation
): WorkPlanCardPost | null {
  const outcome = chain.outcomeSet?.outcomes.find((entry) => taskIdOf(chain, entry))
  const taskId = outcome ? taskIdOf(chain, outcome) : null
  if (!outcome || !taskId) {
    return null
  }
  const live = outcome.evidence.filter((entry) => entry.outcomeRevision === outcome.revision)
  const done = outcome.conditions
    .filter((condition) => live.some((entry) => entry.conditionId === condition.id))
    .map((condition) => clip(condition.label ?? `${condition.kind}: ${condition.target}`, 1000))
  const satisfied = done.length === outcome.conditions.length && outcome.conditions.length > 0
  const history = (chain.outcomeSet?.evidenceHistory ?? []).filter(
    (entry) => entry.outcomeId === outcome.id
  )
  const evidence: WorkPlanCardEvidence[] = [
    ...live.map((entry) => ({
      kind: noteEvidenceKind(entry),
      ref: entry.receipt,
      label: clip(labelOf(outcome, entry), 256)
    })),
    ...history.map((entry) => ({
      kind: noteEvidenceKind(entry),
      ref: entry.receipt,
      label: clip(`revision ${entry.outcomeRevision}: ${labelOf(outcome, entry)}`, 256)
    })),
    ...(chain.verdicts ?? []).map((receipt) => ({
      kind: 'text' as const,
      ref: receipt.consumptionKey,
      label: clip(
        `verdict on ${receipt.stepId}${receipt.skipped ? ' (skipped)' : ''} · attempt ${receipt.attemptId}`,
        256
      )
    }))
  ]
  const next =
    typeof recommendation === 'string'
      ? clip(recommendation, 1000)
      : recommendation?.label
        ? clip(recommendation.label, 1000)
        : 'none'
  const finalReport = satisfied && evidence.length > 0
  return {
    taskId,
    note: {
      note: [
        `${outcome.title} — ${done.length}/${outcome.conditions.length} done when`,
        ...done.map((entry) => `✓ ${entry}`),
        ...(finalReport ? [] : [`Status: ${outcome.status}`]),
        ...(outcome.blockedReason ? [`Blocked: ${outcome.blockedReason}`] : []),
        `Next: ${next}`
      ].join('\n'),
      note_kind: finalReport ? 'final_report' : 'progress',
      payload: {
        summary: clip(
          `${outcome.title}: ${done.length}/${outcome.conditions.length} done when`,
          SUMMARY_MAX
        ),
        done,
        next_action: next,
        evidence,
        knowledge: finalReport
          ? [
              {
                op: 'none',
                reason:
                  'This Outcome was proved by its own execution-host receipts; no estate knowledge search was part of the run.'
              }
            ]
          : []
      }
    },
    evidence: [...live, ...history]
      .map((entry) => taskEvidenceRow(outcome, entry))
      .filter((row): row is WorkPlanTaskEvidenceRow => Boolean(row))
  }
}
