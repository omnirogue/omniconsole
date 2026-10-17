import type {
  GateFailure,
  GateVerdict,
  PlannedItem,
  PreparedFields,
  SessionPrepLaunchLabel,
  SessionPrepSteps
} from './session-prep-types'

const PLACEHOLDER_BRACKET =
  /\[(?:TBD|TODO|TK|FILL[ _-]?IN|INSERT[^\]]{0,40}|NEW NAME|WHICH ONE|NAME\/EMAIL|[A-Z][A-Z0-9 /_-]{2,40})\]/
const PLACEHOLDER_TBD = /\bTBD\b/
const PLACEHOLDER_QQQ = /\?\?\?/
const PLACEHOLDER_FILL = /<fill in>/i
const PLACEHOLDER_PATTERNS = [
  PLACEHOLDER_BRACKET,
  PLACEHOLDER_TBD,
  PLACEHOLDER_QQQ,
  PLACEHOLDER_FILL
]

const RISK_FAMILIES: { family: string; pattern: RegExp }[] = [
  { family: 'deploy', pattern: /\bdeploy|\bship to prod|\bproduction\b|\bprod\b/i },
  { family: 'force', pattern: /force[- ]push|reset --hard|rewrite history/i },
  {
    family: 'destroy',
    pattern:
      /\bdrop (?:table|database)|\bdelete (?:the )?(?:branch|database|table|data|bucket)|\brm -rf\b/i
  },
  { family: 'money', pattern: /\brefund|\bcharge|\bpayout|\btransfer (?:funds|money)|\bbudget\b/i },
  {
    family: 'send',
    pattern:
      /\bsend (?:an? )?(?:email|message|sms)|\bemail (?:the )?customers?|\bpost to (?:twitter|x|facebook|linkedin)/i
  }
]

/** Lowercase, unify quotes/dashes, strip punctuation, collapse whitespace. */
export function normalizePrepText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F`´]/g, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function proseTexts(fields: PreparedFields): string[] {
  return [
    fields.outcome,
    ...fields.doneWhen,
    ...fields.decided,
    ...fields.constraints,
    ...fields.assumptions
  ]
}

/** The first unfilled placeholder in a prose field ([TBD], ???, <fill in>), or null. */
export function findUnresolvedPlaceholder(text: string): string | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      return match[0]
    }
  }
  return null
}

function firstPatternMatch(text: string, pattern: RegExp): string | null {
  const flags = pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`
  const match = text.match(new RegExp(pattern.source, flags))
  return match?.[0] ?? null
}

export function checkPreparedFields(fields: PreparedFields, request: string): GateFailure[] {
  const failures: GateFailure[] = []
  if (fields.outcome.trim() === '') {
    failures.push({ code: 'structure', detail: 'outcome is empty' })
  }
  if (fields.doneWhen.length < 2) {
    failures.push({ code: 'structure', detail: 'doneWhen needs at least 2 checks' })
  }

  for (const text of proseTexts(fields)) {
    const placeholder = findUnresolvedPlaceholder(text)
    if (placeholder) {
      failures.push({ code: 'placeholder', detail: `unresolved placeholder ${placeholder}` })
    }
  }

  const joined = proseTexts(fields).join('\n')
  for (const { family, pattern } of RISK_FAMILIES) {
    if (firstPatternMatch(request, pattern)) {
      continue
    }
    const phrase = firstPatternMatch(joined, pattern)
    if (phrase) {
      failures.push({
        code: 'unrequested-risk',
        detail: `${family}: "${phrase}"`
      })
    }
  }
  return failures
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function section(heading: string, body: string): string {
  return `## ${heading}\n${body}`
}

/** `DW1` in the brief is also the id a verify gate decides that Done When line by. */
export function sessionPrepDoneWhenLabel(index: number): string {
  return `DW${index + 1}`
}

// The worker's receipt: one line per Done When item, so a verifier can test each claim by its label.
function reportSection(count: number): string {
  return section(
    'Report',
    [
      'End your final reply with one line per Done when item, in order:',
      `${sessionPrepDoneWhenLabel(0)} PASS — <the command you ran or the file you opened> → <what it showed>`,
      `${sessionPrepDoneWhenLabel(0)} FAIL — <what you saw>`,
      `A line you could not check is FAIL with the reason. Write all ${count} lines, and only what you actually saw: each one may be re-checked independently.`
    ].join('\n')
  )
}

// Why a constant: the dispatch router must not read these standing guardrails as the task's own risk.
const HOW_TO_WORK = section(
  'How to work',
  [
    '- Work autonomously. For reversible ambiguity, choose a sensible default and note it.',
    '- Stop and ask the person before any production deploy, merge to a protected branch, money movement, customer-facing send, or destructive operation, unless the request above explicitly asks for it.'
  ].join('\n')
)

/** The prompt without the guardrails every prepared prompt carries, as the dispatch router reads it. */
export function sessionPromptWithoutGuardrails(prompt: string): string {
  return prompt.replace(`\n\n${HOW_TO_WORK}`, '')
}

function sessionScope(item: PlannedItem, siblings: string[]): string {
  const covers = item.ask.trim().replace(/[.!?]+$/, '')
  return `This session covers: ${covers}. Sibling sessions in the same batch handle: ${siblings.join('; ')}. Do not do their work.`
}

export function renderSessionPrompt(input: Parameters<SessionPrepSteps['render']>[0]): string {
  const { fields, item, index, request, batchId, ask, siblings, unresolved, launch } = input
  const blocks: string[] = []
  let requestBlock = `Your request (verbatim): "${request}"`
  if (siblings.length > 0) {
    requestBlock += `\n${sessionScope(item, siblings)}`
  }
  blocks.push(requestBlock)
  blocks.push(fields.title)
  if (fields.outcome.trim() !== '') {
    blocks.push(section('Outcome', fields.outcome))
  }
  if (fields.doneWhen.length > 0) {
    blocks.push(
      section(
        'Done when',
        bullets(fields.doneWhen.map((entry, at) => `${sessionPrepDoneWhenLabel(at)}. ${entry}`))
      )
    )
  }
  if (fields.decided.length > 0) {
    blocks.push(section('Decided already', bullets(fields.decided)))
  }
  if (fields.references.length > 0) {
    blocks.push(
      section('References', bullets(fields.references.map((ref) => `\`${ref.path}\` — ${ref.why}`)))
    )
  }
  if (fields.constraints.length > 0) {
    blocks.push(section('Constraints', bullets(fields.constraints)))
  }
  if (fields.assumptions.length > 0) {
    blocks.push(section('Assumptions made while preparing', bullets(fields.assumptions)))
  }
  if (unresolved.length > 0) {
    blocks.push(
      section(
        'Open issues the preparer could not resolve',
        bullets(unresolved.map((f) => f.detail))
      )
    )
  }
  blocks.push(HOW_TO_WORK)
  if (fields.doneWhen.length > 0) {
    blocks.push(reportSection(fields.doneWhen.length))
  }
  if (ask) {
    blocks.push(askSection(ask))
  }
  blocks.push(
    `Prepared by OmniConsole from your message (batch ${batchId}, item ${index + 1}${launchedOn(launch)}).`
  )
  return blocks.join('\n\n')
}

/** "; on codex, gpt-5.6-sol, high effort" — so the session knows what it runs as. */
function launchedOn(launch: SessionPrepLaunchLabel | undefined): string {
  if (!launch) {
    return ''
  }
  const parts = [
    launch.agent,
    ...(launch.model ? [launch.model] : []),
    ...(launch.effort ? [`${launch.effort} effort`] : [])
  ]
  return `; on ${parts.join(', ')}`
}

function askSection(ask: NonNullable<GateVerdict['ask']>): string {
  let askBody = `Before you start, ask the person this with your question tool (AskUserQuestion), then continue with their answer: ${ask.question}`
  if (ask.options.length > 0) {
    askBody += ` Options: ${ask.options.join(' / ')}`
  }
  return section('Ask first', askBody)
}

export function renderDirectPrompt(input: Parameters<SessionPrepSteps['renderDirect']>[0]): string {
  const { item, index, request, batchId, note, ask, launch, siblings = [] } = input
  const blocks: string[] = [request]
  if (siblings.length > 0) {
    blocks.push(sessionScope(item, siblings))
  }
  if (note) {
    blocks.push(note)
  }
  if (ask) {
    blocks.push(askSection(ask))
  }
  blocks.push(
    `Prepared by OmniConsole from your message (batch ${batchId}, item ${index + 1}${launchedOn(launch)}); launched as written.`
  )
  return blocks.join('\n\n')
}
