import type { JsonSchema } from '../../../../shared/json-schema-validate'
import type { WorkflowProgramContext } from '../workflow-program-context'
import { requireAuditResults, type AuditAsk } from './audit-call'
import type { AuditSnapshot } from './audit-snapshot'
import type { AuditReviewedFinding } from './audit-review'
import {
  auditCritiqueIsConsistent,
  auditReviewedMarkdown,
  type AuditReportCritique
} from './audit-report-review'

const text: JsonSchema = { type: 'string', minLength: 1, pattern: '\\S' }
const strings: JsonSchema = { type: 'array', items: text }
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})
const score: JsonSchema = { type: 'integer', minimum: 0, maximum: 10 }
const markdownSchema = object({ markdown: text })
export const AUDIT_PLAN_SCHEMA = object({
  title: text,
  initiatives: {
    type: 'array',
    maxItems: 24,
    items: object({
      themeIds: { ...strings, minItems: 1 },
      change: text,
      owner: text,
      effort: { type: 'string', enum: ['S', 'M', 'L'] },
      expectedGain: text,
      metric: text,
      firstStep: text
    })
  },
  sequence: strings,
  metrics: strings,
  risks: strings
})
export type AuditPlan = {
  title: string
  initiatives: {
    themeIds: string[]
    change: string
    owner: string
    effort: 'S' | 'M' | 'L'
    expectedGain: string
    metric: string
    firstStep: string
  }[]
  sequence: string[]
  metrics: string[]
  risks: string[]
}
export const AUDIT_PLAN_JUDGE_SCHEMA = object({
  scores: {
    type: 'array',
    minItems: 3,
    maxItems: 3,
    items: object({
      label: text,
      grounding: score,
      leverage: score,
      feasibility: score,
      specificity: score,
      reasoning: text
    })
  },
  graft: strings
})
type PlanJudgement = {
  scores: {
    label: string
    grounding: number
    leverage: number
    feasibility: number
    specificity: number
    reasoning: string
  }[]
  graft: string[]
}
const criticSchema = object({
  verdict: { type: 'string', enum: ['ready', 'revise'] },
  gaps: strings,
  unsupportedClaims: strings
})
type Critique = AuditReportCritique

export const AUDIT_REPORT_INSTRUCTION = [
  'Write the audit report as Markdown: scope and deterministic coverage; verified themes with distinct-source counts and short quotes; ranked initiatives with theme IDs, owner, effort, honest expected gain, metric and first step; sequence; metrics; dropped and unverified themes with reasons; method and agreement sample; limitations; open questions.',
  'Use the winning plan as the starting point, graft useful initiatives from the other plans, and disclose ties. Never claim a source was verified if its check is unknown. Unknown status is not unaddressed; shipped work calls for adoption, not rebuilding. Do not invent time savings or costs.'
].join('\n')

const AUDIT_REPORT_INSTRUCTION_REVISION_5 = [
  'For every source quotation, preserve the exact contiguous source text, including capitalization and punctuation, and identify its source ID. If exact wording is unnecessary, paraphrase without quotation marks.',
  'Assess critic concerns against the full report evidence before revising. Apply supported corrections, retain evidence-backed findings, and preserve genuine limitations; do not blindly adopt an unsupported critic claim or arithmetic.'
].join('\n')

export async function planAudit(
  context: WorkflowProgramContext,
  ask: AuditAsk,
  audit: AuditSnapshot,
  reviewed: AuditReviewedFinding[],
  method: unknown
) {
  context.phase('Plan and judge')
  const verified = reviewed.filter((finding) => finding.disposition === 'survived')
  const angles = [
    'Remove bottlenecks and rework',
    'Make recurring manual work repeatable',
    'Improve knowledge reuse and coordination'
  ]
  const dependencies = reviewed.flatMap((_, index) =>
    ['evidence', 'impact', 'status'].map((lens) => `verify/${index}/${lens}`)
  )
  const plans = requireAuditResults(
    await context.parallel(
      audit.plannerSeatIds.map(
        (seat, index) => () =>
          ask(
            `plan/${index}`,
            `Independently plan improvements. Angle: ${angles[index]}. Every initiative must cite verified theme IDs. Name owner, effort, metric and first step. Keep gains qualitative unless independently measured. Explicitly address user wishes and already-shipped work.`,
            seat,
            {
              verified,
              withheld: reviewed.filter((finding) => finding.disposition !== 'survived'),
              method
            },
            AUDIT_PLAN_SCHEMA,
            (value) => {
              const plan = value as AuditPlan
              if (
                plan.initiatives.some((initiative) =>
                  initiative.themeIds.some((id) => !verified.some((finding) => finding.id === id))
                )
              ) {
                throw new Error('Plan cites an unverified or unknown theme')
              }
              return plan
            },
            dependencies
          )
      )
    ),
    'planners'
  ) as AuditPlan[]
  const labels = plans.map((_, i) => `Plan ${String.fromCharCode(65 + i)}`)
  const judges = requireAuditResults(
    await context.parallel(
      audit.judgeSeatIds.map(
        (seat, index) => () =>
          ask(
            `judge/${index}`,
            'Judge each anonymous plan independently on grounding, leverage, feasibility and specificity, each 0–10. Return all labels exactly once. Do not compute totals. Suggest concrete initiatives worth grafting. You did not write these plans.',
            seat,
            {
              verified,
              plans: plans
                .map((plan, i) => ({ label: labels[i], plan }))
                .slice(index)
                .concat(plans.map((plan, i) => ({ label: labels[i], plan })).slice(0, index)),
              ...(audit.version >= 3 ? { reviewed, method } : {})
            },
            AUDIT_PLAN_JUDGE_SCHEMA,
            (value) => {
              const result = value as PlanJudgement
              if (
                new Set(result.scores.map((row) => row.label)).size !== labels.length ||
                result.scores.some((row) => !labels.includes(row.label))
              ) {
                throw new Error('Judge must score every plan exactly once')
              }
              return result
            },
            plans.map((_, i) => `plan/${i}`)
          )
      )
    ),
    'plan judges'
  ) as PlanJudgement[]
  const tally = labels.map((label) => ({
    label,
    total: judges.reduce((total, judge) => {
      const row = judge.scores.find((item) => item.label === label)!
      return total + row.grounding + row.leverage + row.feasibility + row.specificity
    }, 0)
  }))
  const best = Math.max(...tally.map((row) => row.total))
  const winners = tally.filter((row) => row.total === best).map((row) => row.label)
  const reportEvidence = { reviewed, plans, judges, tally, winners, method }
  context.phase('Synthesize and critique')
  const synthesis = await ask(
    'synthesize',
    audit.version >= 5
      ? `${AUDIT_REPORT_INSTRUCTION}\n${AUDIT_REPORT_INSTRUCTION_REVISION_5}`
      : AUDIT_REPORT_INSTRUCTION,
    audit.synthesizerSeatId,
    reportEvidence,
    markdownSchema,
    (value) => value as { markdown: string },
    judges.map((_, i) => `judge/${i}`)
  )
  const critique = await ask(
    'critic',
    audit.version >= 5
      ? 'Check report completeness against the deterministic source manifest, all reader findings, verified themes and user wishes. Name omitted dates, sources, themes and unsupported claims. Require revision if the report treats unknown status as unaddressed or recommends rebuilding shipped work. Check every quotation against its cited source for exact contiguous wording, capitalization and punctuation; when unsupported, identify the quote and source ID.'
      : 'Check report completeness against the deterministic source manifest, all reader findings, verified themes and user wishes. Name omitted dates, sources, themes and unsupported claims. Require revision if the report treats unknown status as unaddressed or recommends rebuilding shipped work.',
    audit.reviewerSeatId,
    audit.version >= 3
      ? { report: synthesis.markdown, ...reportEvidence }
      : { report: synthesis.markdown, reviewed, method },
    criticSchema,
    (value) => {
      const result = value as Critique
      if (audit.version !== 1 && !auditCritiqueIsConsistent(result)) {
        throw new Error('A ready report cannot have unresolved gaps or unsupported claims')
      }
      return result
    },
    ['synthesize']
  )
  const final =
    critique.verdict === 'revise'
      ? await ask(
          'revise',
          audit.version >= 5
            ? 'Assess each critic concern against the supplied source evidence and report data. Apply supported corrections, retain supported findings, and preserve genuine limitations; do not adopt unsupported critic claims or arithmetic. Preserve every source quotation exactly, including capitalization and punctuation, or paraphrase without quotation marks. Return the full report with traceable theme and source IDs.'
            : 'Apply every critic gap; remove or soften unsupported claims. Return the full report and preserve traceable theme IDs. Keep unresolved limitations explicit.',
          audit.synthesizerSeatId,
          audit.version >= 3
            ? { report: synthesis.markdown, critique, ...reportEvidence }
            : { report: synthesis.markdown, critique, reviewed, method },
          markdownSchema,
          (value) => value as { markdown: string },
          ['critic']
        )
      : synthesis
  return {
    plans,
    judges,
    tally,
    winners,
    critique,
    revised: critique.verdict === 'revise',
    markdown:
      audit.version !== 1
        ? auditReviewedMarkdown(final.markdown, critique, audit.version)
        : final.markdown
  }
}
