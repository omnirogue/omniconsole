import { stat } from './benchmark-report'
import type { AuditQualityArm } from './audit-quality-program'
import {
  validateAuditQualityScoring,
  type AuditQualityTrial,
  type AuditAdjudication
} from './audit-quality-validation'
export type { AuditQualityTrial, AuditAdjudication } from './audit-quality-validation'

function score(trial: AuditQualityTrial, label: AuditAdjudication | undefined) {
  if (!label || label.independent !== true || !label.assessor.trim() || !label.evidenceRef.trim()) {
    return null
  }
  const ids = trial.answer?.findings.map((finding) => finding.id) ?? []
  if (
    label.findings.length !== ids.length ||
    new Set(label.findings.map((finding) => finding.findingId)).size !== ids.length ||
    label.findings.some((finding) => !ids.includes(finding.findingId))
  ) {
    throw new Error('Adjudication must cover each proposed finding exactly once')
  }
  if (
    label.findings.some(
      (finding) =>
        typeof finding.valid !== 'boolean' ||
        typeof finding.useful !== 'boolean' ||
        typeof finding.novel !== 'boolean' ||
        (finding.valid && finding.useful && !finding.mechanismId?.trim())
    )
  ) {
    return null
  }
  const useful = label.findings.filter(
    (finding) =>
      trial.state === 'completed' &&
      finding.valid &&
      finding.useful &&
      trial.quoteChecks.some((check) => check.findingId === finding.findingId && check.allVerified)
  )
  return {
    useful: new Set(useful.map((finding) => finding.mechanismId)).size,
    novel: new Set(useful.filter((finding) => finding.novel).map((finding) => finding.mechanismId))
      .size,
    invalid: label.findings.filter((finding) => !finding.valid).length
  }
}

/** Assessor independence is supplied provenance; quote presence never substitutes for a label. */
export function auditQualityScore(
  observations: unknown,
  adjudications: unknown,
  plannedRepetitions: number
) {
  const { trials, labels } = validateAuditQualityScoring(observations, adjudications)
  const repetitions = [...new Set(trials.map((trial) => trial.repetition))]
  if (
    !Number.isSafeInteger(plannedRepetitions) ||
    plannedRepetitions < 1 ||
    trials.length !== plannedRepetitions * 3 ||
    Array.from({ length: plannedRepetitions }, (_, index) => index + 1).some(
      (value) => !repetitions.includes(value)
    )
  ) {
    throw new Error('Incomplete preregistered trial schedule')
  }
  if (
    !trials.length ||
    new Set(trials.map((trial) => trial.sampleId)).size !== trials.length ||
    new Set(trials.map((trial) => trial.inputHash)).size !== 1
  ) {
    throw new Error('Trials need unique IDs and identical frozen inputs')
  }
  for (const repetition of repetitions) {
    const arms = trials.filter((trial) => trial.repetition === repetition).map((trial) => trial.arm)
    if (
      !Number.isSafeInteger(repetition) ||
      repetition < 1 ||
      arms.length !== 3 ||
      ['direct', 'reader-merge', 'full'].some((arm) => !arms.includes(arm as AuditQualityArm))
    ) {
      throw new Error('Every repetition needs all three paired arms')
    }
  }
  if (
    new Set(labels.map((label) => label.sampleId)).size !== labels.length ||
    labels.some((label) => !trials.some((trial) => trial.sampleId === label.sampleId))
  ) {
    throw new Error('Adjudications contain duplicate or unknown samples')
  }
  const scored = trials.map((trial) => ({
    trial,
    score: score(
      trial,
      labels.find((label) => label.sampleId === trial.sampleId)
    )
  }))
  const complete = scored.length > 0 && scored.every((entry) => entry.score !== null)
  return {
    quality: complete
      ? trials.every((trial) => trial.mode === 'live')
        ? 'externally-labelled-development-pilot'
        : 'fixture-behavior-only'
      : 'unknown-awaiting-independent-labels',
    adoption:
      'No production routing change; this development case does not establish general model quality.',
    arms: (['direct', 'reader-merge', 'full'] as const).map((arm) => {
      const rows = scored.filter((entry) => entry.trial.arm === arm)
      return {
        arm,
        runs: rows.length,
        failed: rows.filter((entry) => entry.trial.state === 'failed').length,
        usefulDistinctMechanisms: complete ? stat(rows.map((entry) => entry.score!.useful)) : null,
        usefulNovelMechanisms: complete ? stat(rows.map((entry) => entry.score!.novel)) : null,
        invalidFindings: complete ? stat(rows.map((entry) => entry.score!.invalid)) : null,
        wallClockMs: stat(rows.map((entry) => entry.trial.resources.wallClockMs)),
        attempts: stat(rows.map((entry) => entry.trial.resources.attempts)),
        tokens: rows.every((entry) => entry.trial.resources.tokens !== null)
          ? stat(rows.map((entry) => entry.trial.resources.tokens!))
          : null,
        costUsd: null
      }
    }),
    pairedUsefulDeltas: complete
      ? (['reader-merge', 'full'] as const).map((arm) => ({
          arm,
          versus: 'direct',
          byRepetition: scored
            .filter((entry) => entry.trial.arm === arm)
            .map((entry) => {
              const baseline = scored.find(
                (candidate) =>
                  candidate.trial.arm === 'direct' &&
                  candidate.trial.repetition === entry.trial.repetition
              )
              if (!baseline) {
                throw new Error('Missing paired direct baseline')
              }
              return entry.score!.useful - baseline.score!.useful
            })
        }))
      : null
  }
}
