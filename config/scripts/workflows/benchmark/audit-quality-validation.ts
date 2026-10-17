import { z } from 'zod'
import { AUDIT_QUALITY_ARMS } from './audit-quality-program'

const id = z.string().min(1).regex(/\S/)
const count = z.number().int().nonnegative().safe()
const finding = z
  .object({
    id,
    title: id,
    description: id,
    impact: z.number().int().min(1).max(5),
    proposedFix: id,
    evidence: z.array(z.object({ sourceId: id, quote: z.string().min(1) }).strict()).min(1)
  })
  .strict()
const trialSchema = z
  .object({
    mode: z.enum(['fixture', 'live']),
    sampleId: id,
    arm: z.enum(AUDIT_QUALITY_ARMS),
    repetition: count.min(1),
    inputHash: id,
    state: z.enum(['completed', 'failed']),
    error: z.string().nullable(),
    answer: z
      .object({ findings: z.array(finding), markdown: z.string(), raw: z.unknown() })
      .strict()
      .nullable(),
    quoteChecks: z.array(
      z.object({ findingId: id, allVerified: z.boolean(), distinctSources: count }).strict()
    ),
    resources: z
      .object({
        wallClockMs: z.number().finite().nonnegative(),
        attempts: count,
        tokens: count.nullable(),
        costUsd: z.null(),
        modelIds: z.array(id)
      })
      .strict()
  })
  .strict()
const labelSchema = z
  .object({
    sampleId: id,
    assessor: z.string(),
    independent: z.boolean(),
    evidenceRef: z.string(),
    findings: z.array(
      z
        .object({
          findingId: id,
          valid: z.boolean().nullable(),
          useful: z.boolean().nullable(),
          novel: z.boolean().nullable(),
          mechanismId: z.string().nullable()
        })
        .strict()
    )
  })
  .strict()
export type AuditQualityTrial = z.infer<typeof trialSchema>
export type AuditAdjudication = z.infer<typeof labelSchema>

export const auditQualityManifestSchema = z
  .object({
    version: z.literal(1),
    inputHash: id,
    repetitions: count.min(1).max(5),
    mode: z.enum(['fixture', 'live']),
    arms: z.tuple([z.literal('direct'), z.literal('reader-merge'), z.literal('full')])
  })
  .passthrough()

export function validateAuditQualityScoring(trials: unknown, labels: unknown) {
  const parsed = {
    trials: z.array(trialSchema).parse(trials),
    labels: z.array(labelSchema).parse(labels)
  }
  if (new Set(parsed.trials.map((trial) => trial.mode)).size > 1) {
    throw new Error('Cannot compare fixture and live trials')
  }
  for (const trial of parsed.trials) {
    const ids = trial.answer?.findings.map((finding) => finding.id) ?? []
    if (new Set(ids).size !== ids.length || (trial.state === 'completed' && !trial.answer)) {
      throw new Error('Completed trials require unambiguous answers')
    }
    const checked = trial.quoteChecks.map((check) => check.findingId)
    if (
      new Set(checked).size !== checked.length ||
      checked.some((id) => !ids.includes(id)) ||
      (trial.state === 'completed' && checked.length !== ids.length)
    ) {
      throw new Error('Quote checks must cover each completed finding exactly once')
    }
  }
  return parsed
}
