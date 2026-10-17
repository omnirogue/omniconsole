/**
 * Reads the suggester's reply into contract suggestions. Model output is untrusted: one bad item
 * is dropped rather than voiding the set, every field is clamped, and risk is only ever raised.
 */

import { z } from 'zod'
import {
  NEXT_STEP_PROMPT_MAX,
  NEXT_STEP_SUGGESTION_MAX,
  NEXT_STEP_TITLE_MAX,
  NEXT_STEP_WHY_MAX,
  nextStepRiskOf,
  type NextStepKind,
  type NextStepSuggestion
} from './next-step-suggestions'
import { NEXT_STEP_KINDS } from './next-step-suggestion-prompt'
import { collectSalvageDrops, salvagingArray } from './zod-salvage'

/** Not the prompt example's placeholder: "…" or dots alone is never a step. */
const notPlaceholder = (value: string): boolean => !/^[\s.…]*$/u.test(value)

const oneLine = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim().slice(0, max))
    .pipe(z.string().min(1).refine(notPlaceholder))

const kindOf = (value: unknown): NextStepKind =>
  NEXT_STEP_KINDS.find((kind) => kind === value) ?? 'other'

export const offeredSuggestionSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  title: oneLine(NEXT_STEP_TITLE_MAX),
  prompt: z
    .string()
    .transform((value) => value.trim().slice(0, NEXT_STEP_PROMPT_MAX))
    .pipe(z.string().min(1).refine(notPlaceholder)),
  why: z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim().slice(0, NEXT_STEP_WHY_MAX))
    .optional()
    .catch(undefined),
  risk: z.enum(['safe', 'risky']).optional().catch(undefined),
  kind: z.unknown().transform(kindOf)
})

type OfferedSuggestion = z.output<typeof offeredSuggestionSchema>

/** Contract suggestions from validated items: bounded count, unique ids, risk floor applied. */
export function toNextStepSuggestions(
  items: readonly OfferedSuggestion[],
  options: { keepIds?: boolean } = {}
): NextStepSuggestion[] {
  const used = new Set<string>()
  return items.slice(0, NEXT_STEP_SUGGESTION_MAX).map((item, index) => {
    let id = options.keepIds && item.id && !used.has(item.id) ? item.id : `s${index + 1}`
    // Why a loop: one repair can collide with a later original id ("s3-2", "s3", "s3").
    for (let attempt = 2; used.has(id); attempt++) {
      id = `s${index + 1}-${attempt}`
    }
    used.add(id)
    return {
      id,
      title: item.title,
      prompt: item.prompt,
      ...(item.why ? { why: item.why } : {}),
      // Only an explicit "safe" can read safe: a missing or unreadable claim is risky.
      risk: nextStepRiskOf(
        `${item.title} ${item.prompt} ${item.why ?? ''}`,
        item.risk === 'safe' ? 'safe' : 'risky'
      ),
      kind: item.kind
    }
  })
}

const replySchema = z.object({ suggestions: salvagingArray(offeredSuggestionSchema) })

/** Balanced `{…}` spans in order, honouring JSON strings so a brace inside text does not count. */
function* jsonObjectCandidates(text: string): Generator<string> {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (char === '\\') {
          index++
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth++
      } else if (char === '}' && --depth === 0) {
        yield text.slice(start, index + 1)
        break
      }
    }
  }
}

export type ParsedNextStepOutput =
  | { ok: true; suggestions: NextStepSuggestion[]; dropped: number }
  | { ok: false; error: string }

/**
 * The first reply-shaped object in document order decides, fenced or not. A runner that echoes
 * its input prints the prompt's example before the fenced turn data, so an echo fails closed on
 * the example's placeholders and never reads the data's JSON as the answer.
 */
export function parseNextStepSuggestionOutput(raw: string): ParsedNextStepOutput {
  for (const candidate of jsonObjectCandidates(raw)) {
    let json: unknown
    try {
      json = JSON.parse(candidate)
    } catch {
      continue
    }
    const { value, droppedCount } = collectSalvageDrops(() => replySchema.safeParse(json))
    if (!value.success) {
      continue
    }
    const suggestions = toNextStepSuggestions(value.data.suggestions)
    if (!suggestions.length) {
      return { ok: false, error: 'The suggester answered, but none of its next steps were usable.' }
    }
    return { ok: true, suggestions, dropped: droppedCount }
  }
  return { ok: false, error: 'The suggester did not answer with a list of next steps.' }
}
