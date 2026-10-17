/**
 * Person lookup over the authorised active human roster. Matching folds case, accents
 * and doubled letters so "Iriis", "IRIS" and "Íris" meet; a name that fits more
 * than one person is always returned as a choice, never silently picked.
 */
export type TeamRosterPerson = {
  id: string
  name: string
  role?: string
  title?: string
  department?: string
  photo_url?: string
  image_url?: string
}

export type RosterNameMatch =
  | { kind: 'match'; query: string; person: TeamRosterPerson }
  | { kind: 'choice'; query: string; candidates: TeamRosterPerson[] }
  | { kind: 'none'; query: string }

export function foldPersonName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{L})\1+/gu, '$1')
    .trim()
}

/** One row per id: separately fetched pages may repeat a person. */
export function uniqueRosterPeople(people: readonly TeamRosterPerson[]): TeamRosterPerson[] {
  const byId = new Map<string, TeamRosterPerson>()
  for (const person of people) {
    if (!byId.has(person.id)) {
      byId.set(person.id, person)
    }
  }
  return [...byId.values()]
}

function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) {
    return false
  }
  let i = 0
  let j = 0
  let edits = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) {
      return false
    }
    if (left.length > right.length) {
      i += 1
    } else if (right.length > left.length) {
      j += 1
    } else {
      i += 1
      j += 1
    }
  }
  return edits + (left.length - i) + (right.length - j) <= 1
}

export function resolveRosterName(
  query: string,
  roster: readonly TeamRosterPerson[]
): RosterNameMatch {
  const folded = foldPersonName(query)
  if (!folded) {
    return { kind: 'none', query }
  }
  const names = uniqueRosterPeople(roster).map((person) => ({
    person,
    full: foldPersonName(person.name)
  }))
  const decide = (hits: typeof names): RosterNameMatch | null => {
    if (hits.length === 1) {
      return { kind: 'match', query, person: hits[0]!.person }
    }
    return hits.length > 1
      ? { kind: 'choice', query, candidates: hits.map((hit) => hit.person) }
      : null
  }
  const exact = decide(names.filter((entry) => entry.full === folded))
  if (exact) {
    return exact
  }
  const byToken = decide(
    names.filter(
      (entry) => entry.full.split(' ').includes(folded) || entry.full.startsWith(`${folded} `)
    )
  )
  if (byToken) {
    return byToken
  }
  // Why: a near spelling is a suggestion only; the person confirms who they meant.
  if (folded.length >= 4 && !folded.includes(' ')) {
    const near = names.filter((entry) =>
      entry.full.split(' ').some((part) => withinOneEdit(part, folded))
    )
    if (near.length > 0) {
      return { kind: 'choice', query, candidates: near.map((entry) => entry.person) }
    }
  }
  return { kind: 'none', query }
}

function searchRank(person: TeamRosterPerson, folded: string): number {
  if (!folded) {
    return 1
  }
  const name = foldPersonName(person.name)
  if (name === folded) {
    return 0
  }
  if (name.split(' ').some((part) => part.startsWith(folded)) || name.startsWith(folded)) {
    return 1
  }
  if (name.includes(folded)) {
    return 2
  }
  const detail = foldPersonName(
    [person.role, person.title, person.department].filter(Boolean).join(' ')
  )
  return detail.includes(folded) ? 3 : -1
}

/** Client-side filter over the whole loaded roster; `total` counts every match beyond `limit`. */
export function searchRoster(
  roster: readonly TeamRosterPerson[],
  query: string,
  limit: number
): { people: TeamRosterPerson[]; total: number } {
  const folded = foldPersonName(query)
  const matches = uniqueRosterPeople(roster)
    .map((person) => ({ person, rank: searchRank(person, folded) }))
    .filter((entry) => entry.rank >= 0)
    .sort(
      (left, right) => left.rank - right.rank || left.person.name.localeCompare(right.person.name)
    )
  return { people: matches.slice(0, limit).map((entry) => entry.person), total: matches.length }
}

/** Folded names that more than one person carries, so the picker shows who is who. */
export function duplicateRosterNames(roster: readonly TeamRosterPerson[]): Set<string> {
  const counts = new Map<string, number>()
  for (const person of uniqueRosterPeople(roster)) {
    const folded = foldPersonName(person.name)
    counts.set(folded, (counts.get(folded) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
}

/** Role/title and department, when the roster carries them. */
export function rosterPersonDetail(person: TeamRosterPerson): string | null {
  const parts = [person.role ?? person.title, person.department].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0
  )
  return parts.length > 0 ? parts.join(' · ') : null
}
