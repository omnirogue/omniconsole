import { findUnresolvedPlaceholder } from './session-prep-prompt'
import {
  ORCHESTRATION_TASK_BOUNDARIES,
  ORCHESTRATION_TASK_REPORT_RULES,
  ORCHESTRATION_TASK_TEMPLATES,
  ORCHESTRATION_TASK_TEMPLATE_IDS,
  ORCHESTRATION_TASK_TEMPLATE_VERSION,
  type OrchestrationTaskTemplate,
  type OrchestrationTaskTemplateId
} from './orchestration-task-template-catalog'

export {
  ORCHESTRATION_TASK_TEMPLATE_IDS,
  ORCHESTRATION_TASK_TEMPLATE_VERSION,
  type OrchestrationTaskTemplate,
  type OrchestrationTaskTemplateField,
  type OrchestrationTaskTemplateId
} from './orchestration-task-template-catalog'

/** Validates and renders the production task templates into `orchestration task-create` specs. */

export function isOrchestrationTaskTemplateId(
  value: unknown
): value is OrchestrationTaskTemplateId {
  return (
    typeof value === 'string' &&
    (ORCHESTRATION_TASK_TEMPLATE_IDS as readonly string[]).includes(value)
  )
}

export function getOrchestrationTaskTemplate(
  id: OrchestrationTaskTemplateId
): OrchestrationTaskTemplate {
  return ORCHESTRATION_TASK_TEMPLATES[id]
}

export function listOrchestrationTaskTemplates(): OrchestrationTaskTemplate[] {
  return ORCHESTRATION_TASK_TEMPLATE_IDS.map((id) => ORCHESTRATION_TASK_TEMPLATES[id])
}

export type OrchestrationTaskTemplateProblem = {
  field: string
  problem: 'missing' | 'placeholder' | 'unknown-field'
  detail: string
}

export type RenderedOrchestrationTaskTemplate =
  | { ok: true; spec: string; title: string; reviewTriggers: string[] }
  | { ok: false; problems: OrchestrationTaskTemplateProblem[] }

const ANGLE_PLACEHOLDER = /^<[^<>\n]{1,80}>$/

function unresolvedPlaceholder(value: string): string | null {
  return ANGLE_PLACEHOLDER.test(value) ? value : findUnresolvedPlaceholder(value)
}

function templateProblems(
  template: OrchestrationTaskTemplate,
  values: Readonly<Record<string, string>>
): OrchestrationTaskTemplateProblem[] {
  const problems: OrchestrationTaskTemplateProblem[] = []
  const known = new Set(template.fields.map((entry) => entry.key))
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      // Why: a mistyped key would otherwise drop its text from the brief without a word.
      problems.push({
        field: key,
        problem: 'unknown-field',
        detail: `"${key}" is not a field of the ${template.id} template.`
      })
    }
  }
  for (const entry of template.fields) {
    const value = (values[entry.key] ?? '').trim()
    if (value === '') {
      if (entry.required) {
        problems.push({
          field: entry.key,
          problem: 'missing',
          detail: `${entry.label} is required.`
        })
      }
      continue
    }
    const placeholder = unresolvedPlaceholder(value)
    if (placeholder) {
      problems.push({
        field: entry.key,
        problem: 'placeholder',
        detail: `${entry.label} still holds the placeholder ${placeholder}.`
      })
    }
  }
  return problems
}

// Why: working rule 6 makes these guards Class A (cross-model review); other work needs a stated reason.
const REVIEW_TRIGGERS: readonly { family: string; pattern: RegExp }[] = [
  {
    family: 'auth',
    pattern:
      /\bauth(?:entication|orization|n|z)?\b|\bsign-?in\b|\blog-?in\b|\bcredential|\btoken\b/i
  },
  {
    family: 'permissions',
    pattern: /\bpermission|\baccess control\b|\ballowlist|\bapproval gate|\bguard\b/i
  },
  {
    family: 'cross-host',
    pattern: /\bcross-host\b|\bremote host\b|\bexecution host\b|\bssh\b|\bfederat/i
  },
  { family: 'money', pattern: /\bpayment|\brefund|\bbilling\b|\bpayout|\bcharge\b/i },
  { family: 'migration', pattern: /\bmigration|\bschema change\b/i },
  {
    family: 'destructive',
    pattern: /\bdelet(?:e|es|ing|ion)\b|\bdrop (?:table|database)\b|\bforce[- ]push/i
  }
]

/** The guard families a brief touches. Empty means no standing reason for an independent review. */
export function independentReviewTriggers(text: string): string[] {
  return REVIEW_TRIGGERS.filter(({ pattern }) => pattern.test(text)).map(({ family }) => family)
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

/** The Acceptance field as separate checks: one per line, list markers and numbering dropped. */
export function orchestrationAcceptanceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|A\d+\.?)\s+/, '').trim())
    .filter((line) => line !== '')
}

function numberedAcceptance(text: string): string {
  return orchestrationAcceptanceLines(text)
    .map((line, at) => `- A${at + 1}. ${line}`)
    .join('\n')
}

// A session launched with a contract reports in its reply; only a dispatched worker has worker_done.
const REPLY_REPORT_RULES: readonly string[] = [
  'End your final reply with one line per Acceptance item, in order: "A1 PASS — <command, host, exit code> → <output tail>" or "A1 FAIL — <what you saw>", then one sentence on anything left.',
  'A line you could not check is FAIL with the reason; each one may be re-checked independently.',
  'Anything you could not measure or observe is "unknown": never zero, never assumed.'
]

export function renderOrchestrationTaskTemplate(
  id: OrchestrationTaskTemplateId,
  values: Readonly<Record<string, string>>,
  options: { report?: 'worker-done' | 'reply' } = {}
): RenderedOrchestrationTaskTemplate {
  const template = ORCHESTRATION_TASK_TEMPLATES[id]
  const problems = templateProblems(template, values)
  if (problems.length > 0) {
    return { ok: false, problems }
  }
  const sections = template.fields
    .map((entry) => ({ entry, value: (values[entry.key] ?? '').trim() }))
    .filter(({ value }) => value !== '')
    .map(
      ({ entry, value }) =>
        `## ${entry.label}\n${entry.key === 'acceptance' ? numberedAcceptance(value) : value}`
    )
  const spec = [
    `Production task: ${template.title} (template ${template.id}@${ORCHESTRATION_TASK_TEMPLATE_VERSION})`,
    ...sections,
    `## Stage rules\n${bullets(template.rules)}`,
    `## Boundaries\n${bullets(ORCHESTRATION_TASK_BOUNDARIES)}`,
    `## Report\n${bullets(options.report === 'reply' ? REPLY_REPORT_RULES : ORCHESTRATION_TASK_REPORT_RULES)}`
  ].join('\n\n')
  return {
    ok: true,
    spec,
    title: `${template.title}: ${oneLine(values.objective ?? '', 80)}`,
    reviewTriggers:
      id === 'implement'
        ? independentReviewTriggers(`${values.objective ?? ''}\n${values.scope ?? ''}`)
        : []
  }
}
