import { COMPANY_SLUG_COLOR } from '../../../shared/company-identity'
import { STEWARD_INDEPENDENT_TAG_ID } from '../../../shared/session-steward-suggestions'

export type SessionTag = { id: string; name: string; color: string }
export type SessionTagData = {
  tags: SessionTag[]
  assignments: Record<string, string[]>
  filter: string[]
}
export const SESSION_TAG_COLORS = Object.values(COMPANY_SLUG_COLOR)
/** Competing planners or separate reviewers: the session steward never suggests merging them. */
export const INDEPENDENT_SESSION_TAG: SessionTag = {
  id: STEWARD_INDEPENDENT_TAG_ID,
  name: 'Independent',
  color: COMPANY_SLUG_COLOR.omniagentos
}
/** Every tag list carries the built-in ones, unless the person already has a tag of that name. */
function withBuiltInTags(tags: SessionTag[]): SessionTag[] {
  const taken = tags.some(
    (tag) =>
      tag.id === INDEPENDENT_SESSION_TAG.id ||
      tag.name.toLowerCase() === INDEPENDENT_SESSION_TAG.name.toLowerCase()
  )
  return taken ? tags : [...tags, INDEPENDENT_SESSION_TAG]
}
export function defaultSessionTags(): SessionTagData {
  return {
    tags: [
      { id: 'omnirogue', name: 'OmniRogue', color: COMPANY_SLUG_COLOR.omnirogue },
      { id: 'betacorp', name: 'BetaCorp', color: COMPANY_SLUG_COLOR.betacorp },
      { id: 'acme', name: 'ACME', color: COMPANY_SLUG_COLOR.acme },
      { id: 'omnios', name: 'OmniOS', color: COMPANY_SLUG_COLOR.omniagentos },
      INDEPENDENT_SESSION_TAG
    ],
    assignments: {},
    filter: []
  }
}
export function parseSessionTags(value: unknown): SessionTagData {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid tag data')
  }
  const data = value as SessionTagData
  if (
    !Array.isArray(data.tags) ||
    !data.assignments ||
    typeof data.assignments !== 'object' ||
    !Array.isArray(data.filter)
  ) {
    throw new Error('Invalid tag data')
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const tag of data.tags) {
    if (
      !tag ||
      typeof tag.id !== 'string' ||
      !tag.id ||
      typeof tag.name !== 'string' ||
      !tag.name.trim() ||
      tag.name.length > 40 ||
      !/^#[\da-f]{6}$/i.test(tag.color) ||
      ids.has(tag.id) ||
      names.has(tag.name.toLowerCase())
    ) {
      throw new Error('Invalid tag definition')
    }
    ids.add(tag.id)
    names.add(tag.name.toLowerCase())
  }
  const cleanIds = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.some((id) => typeof id !== 'string')) {
      throw new Error('Invalid tag assignment')
    }
    return [...new Set(input.filter((id) => ids.has(id)))]
  }
  return {
    tags: withBuiltInTags(data.tags),
    assignments: Object.fromEntries(
      Object.entries(data.assignments).map(([key, tags]) => [key, cleanIds(tags)])
    ),
    filter: cleanIds(data.filter)
  }
}
export function sessionTagIds(
  data: SessionTagData,
  key: string,
  automatic?: string | null
): string[] {
  if (Object.hasOwn(data.assignments, key)) {
    return data.assignments[key]
  }
  return automatic && data.tags.some((tag) => tag.id === automatic) ? [automatic] : []
}
export function migrateSessionTags(data: SessionTagData, from: string, to: string): SessionTagData {
  if (from === to || !Object.hasOwn(data.assignments, from)) {
    return data
  }
  const { [from]: previous, ...assignments } = data.assignments
  // An explicit destination choice, including removing all tags, wins.
  if (!Object.hasOwn(assignments, to)) {
    assignments[to] = previous
  }
  return { ...data, assignments }
}
export function matchesSessionTagFilter(
  ids: readonly string[],
  filter: readonly string[]
): boolean {
  return filter.length === 0 || filter.some((id) => ids.includes(id))
}
