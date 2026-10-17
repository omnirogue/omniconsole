import { isRubricKind, type RubricKind } from './rubric-kinds'

/**
 * What a reviewer judges and what may block. A rubric is data: the presets below are starting
 * points a person edits per reviewer, and the text a run starts with is frozen on that run.
 */
export const REVIEW_RUBRIC_IDS = ['general', 'reliability', 'design', 'outcome', 'custom'] as const
export type ReviewRubricId = (typeof REVIEW_RUBRIC_IDS)[number]

export type ReviewRubric = {
  id: ReviewRubricId
  name: string
  instructions: string
}

export const REVIEW_RUBRIC_MAX_CHARS = 6_000
export const REVIEW_RUBRIC_NAME_MAX_CHARS = 80

export const REVIEW_RUBRIC_PRESETS: readonly ReviewRubric[] = [
  {
    id: 'general',
    name: 'General',
    instructions: [
      'Judge whether the work does what the objective asks, is correct, and has no obvious defect.',
      'Blocker: a requirement of the objective is not met, something is wrong (a bug, a false or unsupported claim, a broken step), or the work would harm the person relying on it.',
      'Not a blocker: style, naming, a better alternative, or anything the objective did not ask for. Report those as major, minor or nit.'
    ].join('\n')
  },
  {
    id: 'reliability',
    name: 'Reliability',
    instructions: [
      'Try to break it. Check correctness, edge cases, failure and recovery paths, data integrity, concurrency, and security exposure. For plans and research: feasibility, hidden dependencies, and whether every claim is supported by a source.',
      'Blocker: a reachable failure: an input, state or sequence that produces a wrong result, a crash, lost data, a security hole, or a claim its sources contradict. Name the exact trigger.',
      'Not a blocker: a theoretical risk with no reachable trigger, missing hardening that nothing needs yet, or code style.'
    ].join('\n')
  },
  {
    id: 'design',
    name: 'Design quality',
    instructions: [
      'Judge structure and craft: clarity, hierarchy, consistency with what already exists, accessibility, maintainability, and whether the person can complete the intended task without confusion.',
      'Blocker: a defect a skilled reviewer would reject on its own: the intended task cannot be completed, the structure contradicts the stated constraints or existing conventions, content is unreadable or inaccessible, or the design misleads.',
      'Not a blocker: personal taste. A preference without a stated constraint or convention behind it is a minor or nit.'
    ].join('\n')
  },
  {
    id: 'outcome',
    name: 'Outcome',
    instructions: [
      'Judge whether the deliverable serves its audience and objective: is it complete, useful, and does it meet every stated success criterion? Read it as the person who asked for it would.',
      'Blocker: a stated success criterion or requirement is not met, a part of the objective is missing, or the result does not serve the audience it names.',
      'Not a blocker: ways it could be even better. Never claim real-world impact the evidence cannot show.'
    ].join('\n')
  }
]

export function reviewRubricPreset(id: ReviewRubricId): ReviewRubric | undefined {
  return REVIEW_RUBRIC_PRESETS.find((preset) => preset.id === id)
}

/** A rubric as a run stores it: a known id, a bounded name, bounded non-empty instructions. */
export function normalizeReviewRubric(value: unknown): ReviewRubric | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const id = REVIEW_RUBRIC_IDS.find((entry) => entry === raw.id)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const instructions = typeof raw.instructions === 'string' ? raw.instructions.trim() : ''
  if (
    !id ||
    !name ||
    !instructions ||
    name.length > REVIEW_RUBRIC_NAME_MAX_CHARS ||
    instructions.length > REVIEW_RUBRIC_MAX_CHARS
  ) {
    return undefined
  }
  return { id, name, instructions }
}

/**
 * A rubric a person saved in settings to reuse; named, since presets are the only fixed ids. Its
 * kind (what it judges) groups it in the library; older saved rubrics have none.
 */
export type SavedReviewRubric = { name: string; instructions: string; kind?: RubricKind }
export const SAVED_REVIEW_RUBRICS_MAX = 200

/** Saved rubrics as settings keep them: valid entries, unique names (first wins), bounded. */
export function normalizeSavedReviewRubrics(value: unknown): SavedReviewRubric[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const saved: SavedReviewRubric[] = []
  for (const entry of value) {
    const rubric = normalizeReviewRubric({ ...(entry as object), id: 'custom' })
    const key = rubric?.name.toLowerCase()
    if (rubric && key && !seen.has(key) && saved.length < SAVED_REVIEW_RUBRICS_MAX) {
      seen.add(key)
      const kind = (entry as { kind?: unknown }).kind
      saved.push({
        name: rubric.name,
        instructions: rubric.instructions,
        ...(isRubricKind(kind) ? { kind } : {})
      })
    }
  }
  return saved
}

const HEADER = /^Rubric(?: \(reviewer (\d+)\))?: (.+)$/
const FOCUS_HEADER = 'Review focus:'

/** What a review step's instructions carry: a rubric for all, rubrics per reviewer, a focus. */
export type ReviewStepRubrics = {
  shared?: ReviewRubric
  /** By zero-based reviewer seat; a seat without one reviews against `shared`. */
  perReviewer: (ReviewRubric | undefined)[]
  focus: string
}

function rubricFrom(name: string, body: string): ReviewRubric | undefined {
  const preset = REVIEW_RUBRIC_PRESETS.find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase()
  )
  // A preset named without its text (as a chat-proposed plan writes it) is that preset.
  const isPreset = Boolean(preset && (!body.trim() || body === preset.instructions))
  const rubric = normalizeReviewRubric({
    id: isPreset ? preset!.id : 'custom',
    name: isPreset ? preset!.name : name,
    instructions: body.trim() ? body : (preset?.instructions ?? '')
  })
  // Text is kept as typed (a trailing space or newline mid-edit survives the round trip).
  return rubric && body.trim() ? { ...rubric, instructions: body } : rubric
}

/**
 * A review step's instructions, read: `Rubric: <name>` (all reviewers) and `Rubric (reviewer N):
 * <name>` blocks, each followed by its text, then `Review focus:` and the operator's own words.
 * Plain text, so every place that stores or sends a step's instructions keeps its rubrics. Text
 * that does not start with a rubric is all focus, as review instructions always were.
 */
export function parseReviewStepInstructions(text: string): ReviewStepRubrics {
  const lines = text.split('\n')
  if (!HEADER.test(lines[0] ?? '')) {
    return { perReviewer: [], focus: text }
  }
  const result: ReviewStepRubrics = { perReviewer: [], focus: '' }
  let current: { seat: number | null; name: string; body: string[] } | null = null
  let focus: string[] | null = null
  const close = () => {
    if (!current) {
      return
    }
    // The blank line that separates blocks is layout, not rubric text.
    const body = current.body.at(-1) === '' ? current.body.slice(0, -1) : current.body
    const rubric = rubricFrom(current.name.trim(), body.join('\n'))
    if (rubric && current.seat === null) {
      result.shared = rubric
    } else if (rubric && current.seat !== null) {
      result.perReviewer[current.seat] = rubric
    }
    current = null
  }
  for (const line of lines) {
    const header = focus ? null : HEADER.exec(line)
    if (header) {
      close()
      const seat = header[1] ? Number(header[1]) - 1 : null
      current = {
        seat: seat !== null && seat >= 0 && seat < 64 ? seat : null,
        name: header[2]!,
        body: []
      }
    } else if (!focus && line.trim() === FOCUS_HEADER) {
      close()
      focus = []
    } else if (focus) {
      focus.push(line)
    } else {
      current?.body.push(line)
    }
  }
  close()
  result.focus = (focus ?? []).join('\n')
  return result
}

/** The instructions text for a step's rubrics and focus; with no rubric it is the focus as typed. */
export function composeReviewStepInstructions(value: ReviewStepRubrics): string {
  const blocks = [
    ...(value.shared ? [`Rubric: ${value.shared.name}\n${value.shared.instructions}`] : []),
    ...value.perReviewer.flatMap((rubric, seat) =>
      rubric ? [`Rubric (reviewer ${seat + 1}): ${rubric.name}\n${rubric.instructions}`] : []
    )
  ]
  if (!blocks.length) {
    return value.focus
  }
  return value.focus.length
    ? [...blocks, `${FOCUS_HEADER}\n${value.focus}`].join('\n\n')
    : blocks.join('\n\n')
}

/** What one reviewer seat is asked to judge: its own rubric, or the step's, then the focus. */
export function reviewerStepInstructions(text: string, seat: number): string {
  const parsed = parseReviewStepInstructions(text)
  const rubric = parsed.perReviewer[seat] ?? parsed.shared
  return rubric || parsed.perReviewer.length
    ? composeReviewStepInstructions({
        ...(rubric ? { shared: rubric } : {}),
        perReviewer: [],
        focus: parsed.focus
      })
    : text
}

/** Rubrics a chat-proposed plan names without their text get the preset's text. */
export function expandReviewRubricInstructions(text: string): string {
  const parsed = parseReviewStepInstructions(text)
  return parsed.shared || parsed.perReviewer.length ? composeReviewStepInstructions(parsed) : text
}
