import { z } from 'zod'
import { jevRequestControlSchema } from './jev-control'
import {
  normalizeSavedReviewRubrics,
  REVIEW_RUBRIC_MAX_CHARS,
  REVIEW_RUBRIC_NAME_MAX_CHARS,
  SAVED_REVIEW_RUBRICS_MAX,
  type SavedReviewRubric
} from './review-rubrics'
import { RUBRIC_KINDS } from './rubric-kinds'
import { rubricLibrary, type RubricLibraryEntry } from './rubric-library'

export { JEV_RUBRICS_RUNTIME_CAPABILITY } from './protocol-version'

export const JEV_RUBRIC_METHODS = {
  list: 'jev.rubrics.list',
  save: 'jev.rubrics.save',
  evaluate: 'jev.rubrics.evaluate'
} as const

export const JEV_RUBRIC_MAX_INPUT_BYTES = 48 * 1024
export const JEV_RUBRIC_TASK_MAX_CHARS = 6000
export const JEV_RUBRIC_RESPONSE_MAX_CHARS = 30000
export const JEV_RUBRIC_EVIDENCE_MAX_CHARS = 6000

export const jevRubricSaveSchema = z
  .object({
    rubric: z
      .object({
        name: z.string().max(REVIEW_RUBRIC_NAME_MAX_CHARS).trim().min(1),
        instructions: z.string().max(REVIEW_RUBRIC_MAX_CHARS).trim().min(1),
        kind: z.enum(RUBRIC_KINDS).optional()
      })
      .strict(),
    replace: z.boolean().default(false)
  })
  .strict()

const requiredText = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((text) => text.trim().length > 0, {
      message: 'Text must not be blank.'
    })

export const jevRubricEvaluationSchema = z
  .object({
    input: z
      .object({
        rubric: z.string().trim().min(1).max(200),
        task: requiredText(JEV_RUBRIC_TASK_MAX_CHARS),
        response: requiredText(JEV_RUBRIC_RESPONSE_MAX_CHARS),
        evidence: z
          .object({
            status: z.enum(['verified', 'missing', 'stale', 'conflicting', 'unverified']),
            text: z.string().max(JEV_RUBRIC_EVIDENCE_MAX_CHARS)
          })
          .strict()
          .optional()
      })
      .strict()
      .refine(
        (input) =>
          new TextEncoder().encode(JSON.stringify(input)).byteLength <= JEV_RUBRIC_MAX_INPUT_BYTES,
        { message: 'JEV rubric input exceeds the 48 KB limit.' }
      ),
    control: jevRequestControlSchema.default('request')
  })
  .strict()

export type JevRubricEvaluationInput = z.infer<typeof jevRubricEvaluationSchema>['input']
export type JevRubricSaveInput = z.infer<typeof jevRubricSaveSchema>

/** Resolve once on the owning host; later library edits cannot change the admitted rubric. */
export function resolveJevRubric(
  entries: readonly RubricLibraryEntry[],
  selector: string
): RubricLibraryEntry {
  const exact = entries.find((entry) => entry.value === selector)
  const matches = exact
    ? [exact]
    : entries.filter((entry) => entry.rubric.name.toLowerCase() === selector.toLowerCase())
  if (matches.length !== 1) {
    throw new Error(
      matches.length ? 'Rubric name is ambiguous; select its library value.' : 'Rubric not found.'
    )
  }
  const frozen = structuredClone(matches[0]!)
  Object.freeze(frozen.rubric)
  return Object.freeze(frozen)
}

/** One entry mutation preserves unrelated UI saves and refuses collisions or silent eviction. */
export function saveJevLibraryRubric(
  current: unknown,
  rubric: SavedReviewRubric,
  replace = false
): SavedReviewRubric[] {
  const input = jevRubricSaveSchema.parse({ rubric, replace })
  const name = input.rubric.name.toLowerCase()
  const saved = normalizeSavedReviewRubrics(current)
  if (
    rubricLibrary([]).some(
      (entry) => entry.rubric.name.toLowerCase() === name || entry.value.toLowerCase() === name
    )
  ) {
    throw new Error('Built-in rubrics cannot be replaced.')
  }
  const exists = saved.some((entry) => entry.name.toLowerCase() === name)
  if (exists && !input.replace) {
    throw new Error('A saved rubric with this name already exists; use replace to update it.')
  }
  if (!exists && saved.length >= SAVED_REVIEW_RUBRICS_MAX) {
    throw new Error('Saved rubric limit reached.')
  }
  return [...saved.filter((entry) => entry.name.toLowerCase() !== name), input.rubric]
}
