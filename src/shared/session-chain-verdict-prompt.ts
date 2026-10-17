import { SESSION_VERDICT_MARKER } from './session-chain-verdict'
import type { SessionChainAgentStep } from './session-chain-types'

/** One candidate a verdict ranges over: the exact step id the judge must use, and its label. */
export type SessionVerdictCandidate = { stepId: string; label?: string }

/**
 * What the seat is judging against. `doneWhen` is filled for a `verify` gate — the entries its
 * verdict decides — and `candidateVersion` is the immutable version the host pinned for this seat,
 * which the verdict has to name back.
 */
export type SessionVerdictOutcomeContext = {
  title: string
  doneWhen?: readonly { id: string; label?: string }[]
  candidateVersion?: string
}

/**
 * Predecessor reports are quoted under one header per producing step, so "candidate 2" is never a
 * guess: the judge names the exact id it read. WP-4a inserts the bodies; this is the label.
 */
export function sessionVerdictReportLabel(stepId: string): string {
  return `=== ${stepId} ===`
}

function candidateLines(candidates: readonly SessionVerdictCandidate[]): string[] {
  return candidates.map((candidate) =>
    candidate.label ? `- ${candidate.stepId} (${candidate.label})` : `- ${candidate.stepId}`
  )
}

function doneWhenLines(outcome: SessionVerdictOutcomeContext, over: readonly string[]): string[] {
  const stated = (outcome.doneWhen ?? []).filter((entry) => over.includes(entry.id))
  return stated.map((entry) => (entry.label ? `- ${entry.id}: ${entry.label}` : `- ${entry.id}`))
}

/**
 * The verdict template, filled.
 *
 * It is a SUFFIX and nothing else: `prepareOutcomeStep` appends it, after the person's own
 * instruction, to every step that carries a `verdict`, of any kind, and never replaces what they
 * typed. Why that contract: the structural review step's marker line is appended by the host today
 * (`session-outcome-steps.ts`), but a critique, judge or verify seat sends `step.prompt` verbatim —
 * so a person who edits a reviewer's instruction in the composer drops the marker and the verdict
 * stops being machine-readable. Reviewer and critic prompts stay editable; the verdict contract
 * rides along beside them.
 *
 * Why filled and not a shape: the seat's own step id and the version it judges are substituted
 * here and its attempt id is in the launch brief, so a verdict copied from a candidate names the
 * wrong attempt and is refused instead of being read as this seat's own (hub
 * `canonical_contract.py:2720-2740`). The scoring sentence mirrors `best_of.py:187-247`.
 */
export function buildSessionVerdictInstructions(
  step: SessionChainAgentStep,
  candidates: readonly SessionVerdictCandidate[],
  outcome: SessionVerdictOutcomeContext
): string {
  const verdict = step.verdict
  if (!verdict) {
    return ''
  }
  const version = step.review?.candidateVersion ?? outcome.candidateVersion
  const selects = verdict.consumed === 'select-winner'
  const gates = verdict.consumed === 'gate'
  const doneWhen = gates ? doneWhenLines(outcome, verdict.over) : []
  // A verify gate answers per line, so one agreeable sentence can no longer receipt every line.
  const perLine = gates && verdict.kind === 'verify' && doneWhen.length > 0
  const payload = {
    kind: verdict.kind,
    status: 'pass|findings|fail|insufficient_evidence',
    stepId: step.id,
    attemptId: '<the Launch attempt id from this brief>',
    candidateVersion: version ?? '<the candidate version named above>',
    ...(selects
      ? {
          winnerId: '<the candidate id with the highest score>',
          scores: [{ candidateId: '<candidate id>', score: 0, rationale: 'why' }]
        }
      : {}),
    blockingFindings: ['what blocks and where'],
    ...(perLine
      ? {
          checks: [
            {
              id: '<done-when id>',
              status: 'pass|fail|unknown',
              evidence:
                'the command you ran and what it printed, or the file you opened and what it showed'
            }
          ]
        }
      : {}),
    notes: 'optional'
  }
  return [
    `You are the ${verdict.kind} seat ${step.id} of "${outcome.title}".`,
    'Read only. Do not edit the work you judge or its source files.',
    version ? `Judge this immutable candidate version: ${version}.` : null,
    candidates.length ? 'Judge exactly these, by these exact ids:' : null,
    ...candidateLines(candidates),
    candidates.length
      ? `Each one's report is quoted below under its own ${sessionVerdictReportLabel('<step id>')} header.`
      : null,
    doneWhen.length ? 'Decide each of these, one at a time, against the evidence:' : null,
    ...doneWhen,
    perLine
      ? "Test each line yourself: run its command, open its file, read its output. The worker's report is a claim, not evidence."
      : null,
    perLine
      ? 'Give every line above exactly one entry in "checks", by its exact id: "pass" only with evidence you produced yourself, "fail" with what you actually saw, "unknown" when you could not check it. Copy each failing line into blockingFindings as "<id>: <what failed>", in your own observed words, so the repair gets it unchanged. The status is "pass" only when every check passes.'
      : null,
    selects
      ? 'Score every candidate exactly once with a distinct whole number from 0 to 100, and name as winnerId the one with the highest score. A tie decides nothing and is refused.'
      : null,
    // Where the host reads it, said outright: a seat that put the line only in its chat reply (5 Oct
    // 2026, three attempts in a row) left a correct verdict nowhere the host looks.
    'When you finish with worker_done, your report is its --body: the host reads the verdict only from there, never from your chat reply or your files.',
    'End your report with exactly one verdict line, as its final non-empty line, and quote no other verdict line anywhere in it:',
    `${SESSION_VERDICT_MARKER} ${JSON.stringify(payload)}`,
    'Use "pass" only when nothing blocks and the list is empty; "findings" and "fail" must each name at least one blocker and where it is; use "insufficient_evidence" when you could not judge, naming exactly what evidence is missing. Never infer a pass, and cite the files and the candidate version you actually inspected. Silence never means agreement.'
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n')
}
