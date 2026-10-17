/** What a rubric judges; the picker groups the library by it. */
export const RUBRIC_KINDS = [
  'review',
  'ads',
  'page',
  'reply',
  'repo',
  'code',
  'idea',
  'name',
  'research',
  'plan',
  'post',
  'prompt',
  'other'
] as const
export type RubricKind = (typeof RUBRIC_KINDS)[number]

export function isRubricKind(value: unknown): value is RubricKind {
  return typeof value === 'string' && (RUBRIC_KINDS as readonly string[]).includes(value)
}
