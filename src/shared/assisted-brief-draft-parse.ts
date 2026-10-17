import { z } from 'zod'
import { mentionsUnnamedModel } from './assisted-brief-named-models'
import { boundBriefText, emptyBriefSections } from './assisted-brief-revisions'
import {
  ASSISTED_BRIEF_LIMITS,
  BRIEF_LIST_SECTIONS,
  type BriefChallengeChange,
  type BriefChallengeFinding,
  type BriefContent,
  type BriefItem,
  type BriefItemOrigin,
  type BriefListSection,
  type BriefQuestion
} from './assisted-brief-types'

const draftLine = z.union([
  z.string(),
  z.object({ text: z.string(), source: z.string().optional() })
])
type DraftLine = z.infer<typeof draftLine>
const draftShape = z.object({
  outcome: draftLine,
  scope: z.array(draftLine).optional(),
  constraints: z.array(draftLine).optional(),
  assumptions: z.array(draftLine).optional(),
  deliverables: z.array(draftLine).optional(),
  successChecks: z.array(draftLine).optional(),
  questions: z
    .array(
      z.object({
        question: z.string(),
        choices: z.array(z.string()).optional(),
        section: z.string().optional()
      })
    )
    .optional()
})
const findingShape = z.object({
  kind: z.enum([
    'missed-requirement',
    'unsupported-assumption',
    'unnecessary-work',
    'regression-risk'
  ]),
  note: z.string(),
  change: z
    .object({
      action: z.enum(['add', 'remove', 'none']),
      section: z.string().optional(),
      text: z.string().optional(),
      line: z.string().optional()
    })
    .optional()
})

/** The first JSON object in a model reply, tolerating code fences and stray prose. */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return null
  }
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

const STOPWORDS = new Set([
  'about',
  'also',
  'could',
  'each',
  'from',
  'have',
  'into',
  'just',
  'like',
  'make',
  'more',
  'most',
  'need',
  'only',
  'other',
  'should',
  'some',
  'such',
  'sure',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'using',
  'very',
  'want',
  'what',
  'when',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your'
])

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
    .map((word) => word.slice(0, 4))
}

/** Share of a line's content words that the request also uses. */
export function requestSupport(line: string, request: string): number {
  const words = contentWords(line)
  if (words.length === 0) {
    return 1
  }
  const available = new Set(contentWords(request))
  return words.filter((word) => available.has(word)).length / words.length
}

type DraftContext = { request: string; namedModels: readonly string[]; newId: () => string }

function originFor(
  source: string | undefined,
  text: string,
  context: DraftContext
): BriefItemOrigin {
  if (source === 'assumption') {
    return 'ai-assumption'
  }
  if (source !== 'request') {
    return 'ai-suggestion'
  }
  // Why: a line the model credits to the person must be backed by their words and must not
  // bring in a model they did not name; otherwise it is shown as the AI's suggestion.
  return requestSupport(text, context.request) >= 0.6 &&
    !mentionsUnnamedModel(text, context.namedModels)
    ? 'request'
    : 'ai-suggestion'
}

function toItem(line: DraftLine, context: DraftContext): BriefItem | null {
  const text = boundBriefText(typeof line === 'string' ? line : line.text)
  if (!text) {
    return null
  }
  const source = typeof line === 'string' ? undefined : line.source
  return { id: context.newId(), text, origin: originFor(source, text, context) }
}

function isSection(value: unknown): value is BriefListSection {
  return BRIEF_LIST_SECTIONS.includes(value as BriefListSection)
}

export function parseBriefDraft(
  raw: string,
  context: DraftContext
): { ok: true; content: BriefContent } | { ok: false } {
  const parsed = draftShape.safeParse(extractJsonObject(raw))
  if (!parsed.success) {
    return { ok: false }
  }
  const outcome = toItem(parsed.data.outcome, context)
  if (!outcome) {
    return { ok: false }
  }
  const sections = emptyBriefSections()
  for (const section of BRIEF_LIST_SECTIONS) {
    sections[section] = (parsed.data[section] ?? [])
      .map((line) => toItem(line, context))
      .filter((item): item is BriefItem => item !== null)
      .slice(0, ASSISTED_BRIEF_LIMITS.draftItemsPerSection)
  }
  const questions: BriefQuestion[] = (parsed.data.questions ?? [])
    .map((question) => ({
      id: context.newId(),
      prompt: boundBriefText(question.question, 300),
      choices: [...new Set((question.choices ?? []).map((choice) => boundBriefText(choice, 120)))]
        .filter(Boolean)
        .slice(0, ASSISTED_BRIEF_LIMITS.choicesPerQuestion),
      section: isSection(question.section) ? question.section : 'constraints'
    }))
    .filter((question) => question.prompt)
    .slice(0, ASSISTED_BRIEF_LIMITS.questions)
  return { ok: true, content: { outcome, sections, questions } }
}

function toChange(
  change: z.infer<typeof findingShape>['change'],
  lineIds: Readonly<Record<string, string>>
): BriefChallengeChange {
  if (change?.action === 'add' && isSection(change.section) && change.text?.trim()) {
    return { action: 'add', section: change.section, text: boundBriefText(change.text) }
  }
  const targetItemId = change?.action === 'remove' && change.line ? lineIds[change.line] : undefined
  return targetItemId ? { action: 'remove', targetItemId } : { action: 'none' }
}

export function parseBriefChallenge(
  raw: string,
  context: { lineIds: Readonly<Record<string, string>>; newId: () => string }
): { ok: true; findings: BriefChallengeFinding[] } | { ok: false } {
  const parsed = z.object({ findings: z.array(z.unknown()) }).safeParse(extractJsonObject(raw))
  if (!parsed.success) {
    return { ok: false }
  }
  const findings: BriefChallengeFinding[] = []
  for (const candidate of parsed.data.findings) {
    const finding = findingShape.safeParse(candidate)
    const note = finding.success ? boundBriefText(finding.data.note, 400) : ''
    if (!finding.success || !note) {
      continue
    }
    findings.push({
      id: context.newId(),
      kind: finding.data.kind,
      note,
      change: toChange(finding.data.change, context.lineIds),
      decision: 'pending'
    })
  }
  return { ok: true, findings: findings.slice(0, ASSISTED_BRIEF_LIMITS.findings) }
}
