import type { RubricKind } from './rubric-kinds'
import {
  normalizeSavedReviewRubrics,
  REVIEW_RUBRIC_PRESETS,
  type ReviewRubric,
  type SavedReviewRubric
} from './review-rubrics'

const rubric = (name: string, kind: RubricKind, lines: string[]) => ({
  name,
  kind,
  instructions: lines.join('\n')
})

/**
 * Starter rubrics for what the team judges most. Each is a sentence on what is judged, then one
 * criterion per line: JEV scores every line on its own, and the model judges read the whole.
 * Criteria name a property good work has, never a prohibition: JEV misreads negated wording.
 */
export const LIBRARY_RUBRICS: readonly { name: string; kind: RubricKind; instructions: string }[] =
  [
    rubric('Ad copy', 'ads', [
      'Judge ad copy for a paid campaign by whether it would make the right person act.',
      '- The first line stops the scroll for the target customer',
      '- It makes one clear, specific promise the reader wants',
      '- Every claim is backed by the facts given',
      '- It sounds like a person, not generic marketing hype',
      '- The call to action is clear and matches the offer',
      "- It fits the platform's length and tone"
    ]),
    rubric('Landing page', 'page', [
      'Judge a landing page, or a section of one, by whether a first-time visitor would take the next step.',
      '- The headline says what it is and who it is for in one read',
      "- It leads with the customer's outcome, not the features",
      '- Proof backs every big claim: numbers, quotes or examples',
      '- There is one clear next step',
      '- Every element on it supports that one next step'
    ]),
    rubric('Customer reply', 'reply', [
      "Judge a reply to a customer's support message.",
      '- It answers exactly what the customer asked, completely',
      '- Every fact, promise and policy it states is correct and allowed',
      '- Every refund, cancellation or change it mentions has already been done, or it says plainly that it is still pending',
      '- It is warm, calm and human, without blame or jargon',
      '- It says clearly what happens next and when',
      '- It is short enough to read in under a minute'
    ]),
    rubric('GitHub repository', 'repo', [
      'Judge a software repository as something to adopt, fork or learn from for the task.',
      '- How valuable is the problem it solves for the task?',
      '- Do stars, forks, contributors or usage show real adoption?',
      '- Is it actively maintained, with recent releases and responsive issues?',
      '- Do tests, CI, documentation and structure suggest solid engineering?',
      '- How easily would it fit the stack described in the task?',
      '- Is its license compatible with how we would use it?'
    ]),
    rubric('Code change', 'code', [
      'Judge a code change against the task.',
      '- It does what the task asks, completely and correctly',
      '- It handles edge cases and failures explicitly, surfacing every error',
      "- It follows the codebase's existing patterns and conventions",
      '- It is as simple as it can be, with nothing unnecessary',
      '- It has tests that would catch a regression',
      '- It keeps data and security intact'
    ]),
    rubric('Business idea', 'idea', [
      'Judge a product or business idea on the evidence it gives: can it make money soon with our advantages? Where it gives no evidence, say so rather than guess.',
      '- What evidence shows the problem is painful and frequent for the target customer?',
      '- What does the evidence show about how many customers we can actually reach?',
      '- Is there evidence customers already pay for solutions to this?',
      '- What evidence shows it beats existing alternatives?',
      '- Do we have an unfair way to reach buyers?',
      '- Can we build and ship it with our current skills and tools?',
      '- What evidence supports how quickly it could produce revenue?'
    ]),
    rubric('Product name', 'name', [
      'Judge a product or brand name.',
      '- It is easy to say, spell and remember',
      '- It suggests what the product does or how it should feel',
      "- It is clearly different from competitors' names",
      '- It is likely available as a domain and social handle',
      '- It works in the target markets and languages'
    ]),
    rubric('Research answer', 'research', [
      'Judge a research report or answer: correct, well evidenced, honest about uncertainty, and useful for a decision.',
      '- Does it directly answer the research question asked?',
      '- Are claims supported by specific, checkable sources, data or reasoning?',
      '- Does it draw on independent sources rather than one viewpoint?',
      '- Is the causal and quantitative reasoning sound, without leaps?',
      '- Does it state what is unknown or weakly supported?',
      '- Does it end in implications or next steps a decision-maker can use?'
    ]),
    rubric('Plan', 'plan', [
      'Judge a plan: would following it reach the goal quickly, safely and measurably?',
      "- Does it pursue the task's actual goal rather than a nearby, easier one?",
      '- Can it be carried out with the stated resources, access and time?',
      '- Are its key claims and choices grounded in evidence or marked as assumptions?',
      '- Does it name the main risks, with mitigations or fallbacks?',
      '- Does it define checks that show whether each step worked?',
      '- How soon does it deliver something useful or verifiable?',
      '- Is the effort proportionate to the value?'
    ]),
    rubric('Social post signal', 'post', [
      'Judge a social post as a commercial signal on what it shows: is there a real, reachable, paying need we could serve? Where the post shows nothing, say so rather than guess.',
      '- What does the post show about how strong and urgent the need is?',
      '- What does the post show about how many people share this need?',
      '- What evidence does the post give that people pay, or would pay, to solve it?',
      '- How well could our products or skills meet it?',
      '- What does the post show about whether the need is growing rather than stale or saturated?',
      '- Could we reach these people cheaply?'
    ]),
    rubric('Prompt output', 'prompt', [
      'Judge a model output made under a candidate prompt; comparing outputs ranks the prompts that made them.',
      '- It follows every instruction in the task and its constraints',
      '- Its content is correct and every fact is supported by the input',
      "- It fully solves the user's need",
      '- It is as short as it can be without losing substance',
      '- Its structure and format suit where it will be read',
      '- Its tone suits the audience'
    ])
  ]

/** One rubric in the library: a stable picker value, what it judges, and the rubric itself. */
export type RubricLibraryEntry = {
  value: string
  kind: RubricKind
  builtIn: boolean
  rubric: ReviewRubric
}

export const SAVED_RUBRIC_PREFIX = 'saved:'

/**
 * The whole library, in picker order: the review presets, the starters, then the person's own.
 * The starters travel as custom rubrics, so every host that already reads rubrics reads them.
 */
export function rubricLibrary(saved: readonly SavedReviewRubric[]): RubricLibraryEntry[] {
  return [
    ...REVIEW_RUBRIC_PRESETS.map((preset) => ({
      value: preset.id,
      kind: 'review' as const,
      builtIn: true,
      rubric: preset
    })),
    ...LIBRARY_RUBRICS.map((entry) => ({
      value: `library:${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      kind: entry.kind,
      builtIn: true,
      rubric: { id: 'custom' as const, name: entry.name, instructions: entry.instructions }
    })),
    ...saved.map((entry) => ({
      value: `${SAVED_RUBRIC_PREFIX}${entry.name}`,
      kind: entry.kind ?? ('other' as const),
      builtIn: false,
      rubric: { id: 'custom' as const, name: entry.name, instructions: entry.instructions }
    }))
  ]
}

const FILE_FORMAT = 'omni-rubrics'

/** The person's rubrics as a file to share: plain JSON anyone on the team can import. */
export function rubricsFile(saved: readonly SavedReviewRubric[]): string {
  return `${JSON.stringify(
    {
      format: FILE_FORMAT,
      version: 1,
      rubrics: saved.map((entry) => ({
        name: entry.name,
        kind: entry.kind ?? 'other',
        text: entry.instructions
      }))
    },
    null,
    2
  )}\n`
}

/** Rubrics from a shared file, validated like saved ones, or why the file cannot be used. */
export function readRubricsFile(text: string): SavedReviewRubric[] | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'This file is not a rubrics file: it is not valid JSON.' }
  }
  const record = data as { format?: unknown; rubrics?: unknown } | null
  if (!record || record.format !== FILE_FORMAT || !Array.isArray(record.rubrics)) {
    return { error: 'This file is not an OmniConsole rubrics file.' }
  }
  const rubrics = normalizeSavedReviewRubrics(
    record.rubrics.map((entry) => {
      const raw = (entry ?? {}) as Record<string, unknown>
      return { name: raw.name, instructions: raw.text, kind: raw.kind }
    })
  )
  return rubrics.length ? rubrics : { error: 'The file has no rubrics that can be used.' }
}
