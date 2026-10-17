/**
 * The two card tags the IDE gives meaning to. The hub stores a card's tags verbatim
 * (at most 20, each at most 40 characters) and every client reads the same list, so a
 * proposal and its extra companies survive a round trip through omnios, the MCP and chat.
 *
 * `proposed` — an idea on the Kanban's Proposed lane: valid, filed, not yet committed.
 * `company:<slug>` — an additional company the card is for; the primary one stays in
 * `org_company_id` because the hub files a card under exactly one company.
 */
export const PROPOSED_TAG = 'proposed'
export const COMPANY_TAG_PREFIX = 'company:'
/** The hub's own bounds (omniagentos collab routes, migration 265). */
export const CARD_TAG_MAX_LENGTH = 40
export const CARD_TAGS_MAX = 20

/** The board-eligible sources: the hub shows only these on the Kanban. */
export const CHAT_CARD_SOURCE = 'omniconsole-task'

type Tags = readonly string[] | null | undefined

function cleaned(tags: Tags): string[] {
  const seen = new Set<string>()
  for (const raw of tags ?? []) {
    const tag = raw.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
    }
  }
  return [...seen]
}

export function isProposedTask(tags: Tags): boolean {
  return (tags ?? []).some((tag) => tag.trim().toLowerCase() === PROPOSED_TAG)
}

/** A company slug as the hub spells it: lower-case, no surrounding space. */
export function companySlugKey(slug: string): string {
  return slug.trim().toLowerCase()
}

export function companyTag(slug: string): string {
  return `${COMPANY_TAG_PREFIX}${companySlugKey(slug)}`
}

/** The extra companies a card names, in tag order, without the primary one. */
export function additionalCompanySlugs(tags: Tags, primarySlug?: string | null): string[] {
  const primary = primarySlug ? companySlugKey(primarySlug) : ''
  const slugs: string[] = []
  for (const tag of cleaned(tags)) {
    if (!tag.toLowerCase().startsWith(COMPANY_TAG_PREFIX)) {
      continue
    }
    const slug = companySlugKey(tag.slice(COMPANY_TAG_PREFIX.length))
    if (slug && slug !== primary && !slugs.includes(slug)) {
      slugs.push(slug)
    }
  }
  return slugs
}

/** Every company a card is for: the filed one first, then the tagged extras. */
export function taskCompanySlugs(primarySlug: string | null | undefined, tags: Tags): string[] {
  const primary = primarySlug ? companySlugKey(primarySlug) : ''
  return [...(primary ? [primary] : []), ...additionalCompanySlugs(tags, primary)]
}

export function withProposed(tags: Tags, proposed: boolean): string[] {
  const rest = cleaned(tags).filter((tag) => tag.toLowerCase() !== PROPOSED_TAG)
  return proposed ? [PROPOSED_TAG, ...rest] : rest
}

/**
 * Replace the card's company tags with `slugs` (the primary company is never tagged), keeping
 * every other tag. Slugs that would not fit the hub's tag length are dropped, never truncated:
 * a truncated slug would name a company that does not exist.
 */
export function withAdditionalCompanies(
  tags: Tags,
  slugs: readonly string[],
  primarySlug?: string | null
): string[] {
  const primary = primarySlug ? companySlugKey(primarySlug) : ''
  const rest = cleaned(tags).filter((tag) => !tag.toLowerCase().startsWith(COMPANY_TAG_PREFIX))
  const companies: string[] = []
  for (const raw of slugs) {
    const slug = companySlugKey(raw)
    const tag = companyTag(slug)
    if (!slug || slug === primary || companies.includes(tag) || tag.length > CARD_TAG_MAX_LENGTH) {
      continue
    }
    companies.push(tag)
  }
  return [...rest, ...companies]
}

/** The extra-company slugs a card cannot carry (their tag would exceed the hub's length). */
export function unfitCompanySlugs(slugs: readonly string[]): string[] {
  return slugs
    .map(companySlugKey)
    .filter((slug) => slug && companyTag(slug).length > CARD_TAG_MAX_LENGTH)
}

/** The tags a new card is filed with, or an empty list when nothing needs marking. */
export function newTaskTags(input: {
  proposed?: boolean
  primarySlug?: string | null
  additionalCompanySlugs?: readonly string[]
}): string[] {
  return withAdditionalCompanies(
    withProposed([], input.proposed === true),
    input.additionalCompanySlugs ?? [],
    input.primarySlug
  )
}

/** True when the list is within what the hub accepts; the hub refuses, never truncates. */
export function fitsCardTagBounds(tags: readonly string[]): boolean {
  return tags.length <= CARD_TAGS_MAX && tags.every((tag) => tag.length <= CARD_TAG_MAX_LENGTH)
}
