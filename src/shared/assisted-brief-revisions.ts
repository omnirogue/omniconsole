import { computeBriefContentHash } from './assisted-brief-hash'
import { extractNamedModels } from './assisted-brief-named-models'
import {
  ASSISTED_BRIEF_LIMITS,
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefActor,
  type BriefClock,
  type BriefContent,
  type BriefItem,
  type BriefItemOrigin,
  type BriefListSection,
  type BriefOriginalRequest,
  type BriefRevision,
  type BriefRevisionCause
} from './assisted-brief-types'

const PERSON_ORIGINS: ReadonlySet<BriefItemOrigin> = new Set(['request', 'answer', 'person'])

/** The person's requirements, as opposed to AI assumptions and suggestions. */
export function isPersonOrigin(origin: BriefItemOrigin): boolean {
  return PERSON_ORIGINS.has(origin)
}

export function boundBriefText(
  text: string,
  max: number = ASSISTED_BRIEF_LIMITS.itemChars
): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}

export function emptyBriefSections(): Record<BriefListSection, BriefItem[]> {
  return { scope: [], constraints: [], assumptions: [], deliverables: [], successChecks: [] }
}

export function currentBriefRevision(record: AssistedBriefRecord): BriefRevision {
  const current = record.revisions.at(-1)
  if (!current) {
    throw new Error('A brief always keeps its current revision.')
  }
  return current
}

function hashFor(
  record: Pick<AssistedBriefRecord, 'workspaceKey' | 'original' | 'namedModels'>,
  content: BriefContent
): string {
  return computeBriefContentHash(content, {
    workspaceKey: record.workspaceKey,
    original: record.original,
    namedModels: record.namedModels
  })
}

/** Longer requests cannot be stored verbatim, so drafting refuses them instead of trimming. */
export function isBriefRequestTooLong(text: string): boolean {
  return text.length > ASSISTED_BRIEF_LIMITS.requestChars
}

export function createBriefRecord(input: {
  briefId: string
  workspaceKey: string
  original: BriefOriginalRequest
  drafter: BriefActor
  content: BriefContent
  now: number
}): AssistedBriefRecord {
  // Why: the request is stored verbatim; one over the limit fails validation on save, never trimmed.
  const original = {
    text: input.original.text,
    attachments: input.original.attachments.slice(0, ASSISTED_BRIEF_LIMITS.attachments)
  }
  const base = {
    version: 1 as const,
    briefId: input.briefId,
    workspaceKey: input.workspaceKey,
    original,
    namedModels: extractNamedModels(original.text),
    drafter: input.drafter,
    approval: null,
    starts: [],
    challenge: null,
    challengeCycles: 0,
    updatedAt: input.now
  }
  const first: BriefRevision = {
    number: 1,
    cause: 'drafted',
    createdAt: input.now,
    content: input.content,
    contentHash: hashFor(base, input.content)
  }
  return { ...base, revisions: [first] }
}

/** Every change is a new revision, so an approval of an earlier revision stops applying. */
export function reviseBrief(
  record: AssistedBriefRecord,
  content: BriefContent,
  cause: BriefRevisionCause,
  now: number
): AssistedBriefRecord {
  const revision: BriefRevision = {
    number: currentBriefRevision(record).number + 1,
    cause,
    createdAt: now,
    content,
    contentHash: hashFor(record, content)
  }
  return {
    ...record,
    revisions: [...record.revisions, revision].slice(-ASSISTED_BRIEF_LIMITS.revisionsKept),
    approval: null,
    updatedAt: now
  }
}

/** A brief shown for another workspace or host needs a fresh approval there. */
export function rebindBriefWorkspace(
  record: AssistedBriefRecord,
  workspaceKey: string,
  now: number
): AssistedBriefRecord {
  if (record.workspaceKey === workspaceKey) {
    return record
  }
  const content = currentBriefRevision(record).content
  return reviseBrief({ ...record, workspaceKey }, content, 'workspace-changed', now)
}

function withSections(
  content: BriefContent,
  map: (items: BriefItem[], section: BriefListSection) => BriefItem[]
): BriefContent {
  const sections = emptyBriefSections()
  for (const section of BRIEF_LIST_SECTIONS) {
    sections[section] = map(content.sections[section], section)
  }
  return { ...content, sections }
}

export function isBriefSectionFull(content: BriefContent, section: BriefListSection): boolean {
  return content.sections[section].length >= ASSISTED_BRIEF_LIMITS.itemsPerSection
}

/** Sections that these answers would push past the stored line limit. */
export function sectionsOverflowedByAnswers(
  content: BriefContent,
  answers: Readonly<Record<string, string>>
): BriefListSection[] {
  const added = new Map<BriefListSection, number>()
  for (const question of content.questions) {
    if (boundBriefText(answers[question.id] ?? '')) {
      added.set(question.section, (added.get(question.section) ?? 0) + 1)
    }
  }
  return BRIEF_LIST_SECTIONS.filter(
    (section) =>
      content.sections[section].length + (added.get(section) ?? 0) >
      ASSISTED_BRIEF_LIMITS.itemsPerSection
  )
}

export function addPersonItem(
  record: AssistedBriefRecord,
  section: BriefListSection,
  text: string,
  clock: BriefClock
): AssistedBriefRecord | null {
  const clean = boundBriefText(text)
  const content = currentBriefRevision(record).content
  if (!clean || isBriefSectionFull(content, section)) {
    return null
  }
  const item: BriefItem = { id: clock.newId(), text: clean, origin: 'person' }
  const next = withSections(content, (items, key) => (key === section ? [...items, item] : items))
  return reviseBrief(record, next, 'added', clock.now)
}

export function removeBriefItem(
  record: AssistedBriefRecord,
  itemId: string,
  clock: BriefClock
): AssistedBriefRecord | null {
  const content = currentBriefRevision(record).content
  const next = withSections(content, (items) => items.filter((item) => item.id !== itemId))
  const removed = BRIEF_LIST_SECTIONS.some(
    (section) => next.sections[section].length !== content.sections[section].length
  )
  return removed ? reviseBrief(record, next, 'removed', clock.now) : null
}

/** Plain-text form of the brief for "Edit brief": one line per requirement or suggestion. */
export type BriefEditDraft = { outcome: string; sections: Record<BriefListSection, string> }

export function briefEditDraft(content: BriefContent): BriefEditDraft {
  const sections = {} as Record<BriefListSection, string>
  for (const section of BRIEF_LIST_SECTIONS) {
    sections[section] = content.sections[section].map((item) => item.text).join('\n')
  }
  return { outcome: content.outcome.text, sections }
}

/** Unchanged lines keep who wrote them; changed or new lines become the person's own. */
export function applyBriefEdit(
  record: AssistedBriefRecord,
  draft: BriefEditDraft,
  clock: BriefClock
): AssistedBriefRecord | null {
  const current = currentBriefRevision(record)
  const outcomeText = boundBriefText(draft.outcome)
  if (!outcomeText) {
    return null
  }
  const outcome: BriefItem =
    outcomeText === current.content.outcome.text
      ? current.content.outcome
      : { id: current.content.outcome.id, text: outcomeText, origin: 'person' }
  const next = withSections({ ...current.content, outcome }, (items, section) => {
    const previous = [...items]
    return draft.sections[section]
      .split('\n')
      .map((line) => boundBriefText(line.replace(/^\s*[-*•]\s*/, '')))
      .filter(Boolean)
      .slice(0, ASSISTED_BRIEF_LIMITS.itemsPerSection)
      .map((line) => {
        const index = previous.findIndex((item) => item.text === line)
        return index === -1
          ? { id: clock.newId(), text: line, origin: 'person' as const }
          : previous.splice(index, 1)[0]
      })
  })
  return hashFor(record, next) === current.contentHash
    ? null
    : reviseBrief(record, next, 'edited', clock.now)
}

/** Answers are the person's requirements; answered questions leave the open list. */
export function answerBriefQuestions(
  record: AssistedBriefRecord,
  answers: Readonly<Record<string, string>>,
  clock: BriefClock
): AssistedBriefRecord | null {
  const content = currentBriefRevision(record).content
  const answered = content.questions.filter((question) =>
    boundBriefText(answers[question.id] ?? '')
  )
  if (answered.length === 0 || sectionsOverflowedByAnswers(content, answers).length > 0) {
    return null
  }
  const next = withSections(content, (items, section) => [
    ...items,
    ...answered
      .filter((question) => question.section === section)
      .map((question) => ({
        id: clock.newId(),
        text: boundBriefText(`${question.prompt} — ${answers[question.id]}`),
        origin: 'answer' as const
      }))
  ])
  next.questions = content.questions.filter((question) => !answered.includes(question))
  return reviseBrief(record, next, 'answered', clock.now)
}

export type BriefLine = { section: BriefListSection; item: BriefItem }

/** Requirements and AI proposals, kept apart for display and for the execution prompt. */
export function splitBriefLines(content: BriefContent): {
  requirements: BriefLine[]
  proposals: BriefLine[]
} {
  const lines = BRIEF_LIST_SECTIONS.flatMap((section) =>
    content.sections[section].map((item) => ({ section, item }))
  )
  return {
    requirements: lines.filter((line) => isPersonOrigin(line.item.origin)),
    proposals: lines.filter((line) => !isPersonOrigin(line.item.origin))
  }
}
