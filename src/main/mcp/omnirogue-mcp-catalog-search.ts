export type OmniRogueMcpCatalogTool = {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema?: Readonly<Record<string, unknown>>
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function parameterNames(tool: OmniRogueMcpCatalogTool): string {
  const properties = tool.inputSchema?.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return ''
  }
  return normalize(Object.keys(properties).join(' '))
}

function matchScore(
  tool: OmniRogueMcpCatalogTool,
  query: string,
  terms: readonly string[]
): number {
  const name = normalize(tool.name)
  if (!name) {
    return -1
  }
  if (!terms.length) {
    return 0
  }
  const words = name.split(' ')
  const title = normalize(tool.title ?? '')
  const description = normalize(tool.description ?? '')
  const parameters = parameterNames(tool)
  let score = name === query ? 100 : name.startsWith(query) ? 40 : name.includes(query) ? 20 : 0
  for (const term of terms) {
    if (words.includes(term)) {
      score += 12
    } else if (words.some((word) => word.startsWith(term))) {
      score += 8
    } else if (name.includes(term)) {
      score += 4
    } else if (title.includes(term)) {
      score += 3
    } else if (parameters.includes(term)) {
      score += 2
    } else if (description.includes(term)) {
      score += 1
    } else {
      return -1
    }
  }
  return score
}

/** Searches supplied tool metadata only; schemas and tool definitions are returned unchanged. */
export function searchOmniRogueMcpCatalog<T extends OmniRogueMcpCatalogTool>(
  catalog: readonly T[],
  query: string,
  limit = DEFAULT_LIMIT
): T[] {
  const count = Number.isFinite(limit)
    ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit)))
    : DEFAULT_LIMIT
  const normalizedQuery = normalize(query)
  if (!count || (query.trim() && !normalizedQuery)) {
    return []
  }
  const terms = [...new Set(normalizedQuery.split(' ').filter(Boolean))]
  const matches: { tool: T; score: number }[] = []
  for (const tool of catalog) {
    const score = matchScore(tool, normalizedQuery, terms)
    if (score >= 0) {
      matches.push({ tool, score })
    }
  }
  // Code-point ordering keeps equal-score results identical across host locales.
  matches.sort((left, right) => {
    const difference = right.score - left.score
    if (difference) {
      return difference
    }
    return left.tool.name < right.tool.name ? -1 : left.tool.name > right.tool.name ? 1 : 0
  })
  return matches.slice(0, count).map(({ tool }) => tool)
}
