// Turns what a person types into FTS5 match expressions. The index tokenizes like
// `unicode61`: every run of letters/digits is a token, so `prod-omnirogue`, a URL or a path
// becomes a token sequence and is matched as a phrase.

export type SessionSearchTermKind = 'word' | 'phrase' | 'identifier'

export type SessionSearchTermGroup = {
  /** What the person typed for this term. */
  label: string
  kind: SessionSearchTermKind
  /** Token sequences that count as this term; the first is the typed form. */
  alternatives: string[][]
  /** Alternatives that came from the abbreviation table, for the "why it matched" line. */
  expansions: string[]
  /** Last alternative token of the typed form may match as a prefix. */
  prefix: boolean
}

export type SessionSearchPlan = {
  groups: SessionSearchTermGroup[]
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'with'
])

// Abbreviations people and agents use interchangeably. Deliberately small: each entry must be
// the same thing, not a related idea, or keyword results stop being exact.
const EQUIVALENTS: string[][] = [
  ['production', 'prod'],
  ['development', 'dev'],
  ['staging', 'stg'],
  ['repository', 'repo'],
  ['configuration', 'config'],
  ['environment', 'env'],
  ['database', 'db'],
  ['authentication', 'auth'],
  ['documentation', 'docs'],
  ['message', 'msg'],
  ['kubernetes', 'k8s'],
  ['pull request', 'pr'],
  ['continuous integration', 'ci'],
  ['application', 'app'],
  ['organization', 'org'],
  ['credentials', 'creds'],
  ['deploy', 'deployment', 'rollout'],
  ['summary', 'summaries', 'recap']
]

const URL_SCHEME_TOKENS = new Set(['http', 'https', 'www'])
const MIN_PREFIX_CHARS = 4

export function searchTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function equivalentsOf(tokens: string[]): string[][] {
  const typed = tokens.join(' ')
  for (const group of EQUIVALENTS) {
    if (group.includes(typed)) {
      return group.filter((entry) => entry !== typed).map(searchTokens)
    }
  }
  return []
}

/** A light suffix trim so `deploying`, `deployed` and `deployment` all prefix-match `deploy`. */
export function prefixStem(token: string): string {
  if (token.length < 6 || /\d/.test(token)) {
    return token
  }
  for (const suffix of ['ments', 'ment', 'ing', 'ies', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && !token.endsWith('ss')) {
      const stem = token.slice(0, -suffix.length)
      return stem.length >= MIN_PREFIX_CHARS ? stem : token
    }
  }
  return token
}

function isIdentifier(token: string): boolean {
  return (/\d/.test(token) && /[a-z]/.test(token) && token.length >= 6) || /^\d{3,}$/.test(token)
}

function wordGroup(label: string, tokens: string[]): SessionSearchTermGroup {
  if (tokens.length > 1) {
    const trimmed =
      tokens.length > 2 && URL_SCHEME_TOKENS.has(tokens[0]!) ? tokens.slice(1) : tokens
    const alternatives = [trimmed, ...equivalentsOf(trimmed)]
    return {
      label,
      kind: 'phrase',
      alternatives,
      expansions: alternatives.slice(1).map((alt) => alt.join(' ')),
      prefix: false
    }
  }
  const token = tokens[0]!
  if (isIdentifier(token)) {
    return { label, kind: 'identifier', alternatives: [[token]], expansions: [], prefix: true }
  }
  const expansions = equivalentsOf([token])
  return {
    label,
    kind: 'word',
    alternatives: [[prefixStem(token)], ...expansions],
    expansions: expansions.map((alt) => alt.join(' ')),
    prefix: token.length >= MIN_PREFIX_CHARS
  }
}

/** Split a query into term groups: quoted text stays one phrase, each other word is a term. */
export function planSessionSearchQuery(raw: string): SessionSearchPlan {
  const groups: SessionSearchTermGroup[] = []
  const rest = raw.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const tokens = searchTokens(phrase)
    if (tokens.length > 0) {
      groups.push({
        label: phrase.trim(),
        kind: 'phrase',
        alternatives: [tokens],
        expansions: [],
        prefix: false
      })
    }
    return ' '
  })
  const words = rest.split(/\s+/).filter(Boolean)
  const candidates = words
    .map((word) => ({ word, tokens: searchTokens(word) }))
    .filter((entry) => entry.tokens.length > 0)
  const meaningful = candidates.filter(
    (entry) => entry.tokens.length > 1 || !STOPWORDS.has(entry.tokens[0]!)
  )
  for (const entry of meaningful.length > 0 ? meaningful : candidates) {
    groups.push(wordGroup(entry.word, entry.tokens))
  }
  return { groups: dedupeGroups(groups) }
}

function dedupeGroups(groups: SessionSearchTermGroup[]): SessionSearchTermGroup[] {
  const seen = new Set<string>()
  return groups.filter((group) => {
    const key = group.alternatives[0]!.join(' ')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function quotePhrase(tokens: string[], prefix: boolean): string {
  // Tokens are letters/digits only, so wrapping in double quotes cannot break out.
  return `"${tokens.join(' ')}"${prefix ? '*' : ''}`
}

/** `("prod" OR "production")` for one term group. */
export function groupMatchExpression(group: SessionSearchTermGroup): string {
  const parts = group.alternatives.map((tokens, index) =>
    quotePhrase(tokens, index === 0 && group.prefix)
  )
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`
}

const PROXIMITY_TOKENS = 4
const MAX_PROXIMITY_COMBINATIONS = 12

/**
 * Terms found next to each other (`prod-omnirogue` for "omnirogue production"): the strongest
 * sign that a session is about the combination rather than mentioning each word somewhere.
 */
export function proximityExpression(plan: SessionSearchPlan): string | null {
  if (plan.groups.length < 2 || plan.groups.length > 4) {
    return null
  }
  let combinations: string[][] = [[]]
  for (const group of plan.groups) {
    const phrases = group.alternatives.map((tokens, index) =>
      quotePhrase(tokens, index === 0 && group.prefix)
    )
    combinations = combinations.flatMap((prefix) => phrases.map((phrase) => [...prefix, phrase]))
    if (combinations.length > MAX_PROXIMITY_COMBINATIONS) {
      combinations = combinations.slice(0, MAX_PROXIMITY_COMBINATIONS)
    }
  }
  return combinations
    .map((phrases) => `NEAR(${phrases.join(' ')}, ${PROXIMITY_TOKENS})`)
    .join(' OR ')
}

export function allGroupsExpression(plan: SessionSearchPlan): string {
  return plan.groups.map(groupMatchExpression).join(' AND ')
}

export function anyGroupExpression(plan: SessionSearchPlan): string {
  return plan.groups.map(groupMatchExpression).join(' OR ')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive pattern that finds any alternative of any group in raw transcript text. */
export function highlightPattern(plan: SessionSearchPlan): RegExp | null {
  const sources: string[] = []
  for (const group of plan.groups) {
    group.alternatives.forEach((tokens, index) => {
      const body = tokens.map(escapeRegExp).join('[^\\p{L}\\p{N}]+')
      const tail = index === 0 && group.prefix ? '[\\p{L}\\p{N}]*' : ''
      sources.push(`${body}${tail}`)
    })
  }
  if (sources.length === 0) {
    return null
  }
  sources.sort((a, b) => b.length - a.length)
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${sources.join('|')})(?![\\p{L}\\p{N}])`, 'giu')
}
