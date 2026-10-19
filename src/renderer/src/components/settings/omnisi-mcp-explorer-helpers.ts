export type OmniSiMcpTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export const omniSiMcpExplorerLabels = {
  title: 'OmniSI MCP explorer',
  description: 'Browse the tools available through your OmniSI connection.',
  close: 'Close',
  search: 'Search tools',
  searchPlaceholder: 'Search by name or description',
  clearSearch: 'Clear search',
  refresh: 'Refresh',
  loading: 'Loading tools…',
  loadError: 'Unable to load tools.',
  empty: 'No tools are available.',
  noMatches: 'No tools match your search.',
  tools: 'Tools',
  details: 'Tool details',
  noDescription: 'No description provided.',
  parameters: 'Parameters',
  noParameters: 'No input properties are declared. See the schema for other constraints.',
  required: 'Required',
  optional: 'Optional',
  unknownType: 'Unspecified type',
  inputSchema: 'Input schema',
  schemaUnavailable: 'No readable input schema is available.',
  toolCount: (visible: number, total: number): string => `${visible} of ${total} tools`
}

export type OmniSiMcpExplorerLabels = typeof omniSiMcpExplorerLabels

export type OmniSiMcpParameter = {
  name: string
  type: string | undefined
  description: string | undefined
  required: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function filterOmniSiMcpTools(
  tools: readonly OmniSiMcpTool[],
  query: string
): OmniSiMcpTool[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return tools.filter((tool) => {
    const searchable = [tool.name, tool.title, tool.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function getOmniSiMcpParameters(schema: OmniSiMcpTool['inputSchema']): OmniSiMcpParameter[] {
  if (!schema || !isRecord(schema.properties)) {
    return []
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
  )
  return Object.entries(schema.properties).map(([name, value]) => {
    const property = isRecord(value) ? value : {}
    const types = Array.isArray(property.type)
      ? property.type.filter((type): type is string => typeof type === 'string')
      : []
    return {
      name,
      type: typeof property.type === 'string' ? property.type : types.join(' | ') || undefined,
      description: typeof property.description === 'string' ? property.description : undefined,
      required: required.has(name)
    }
  })
}

export function formatOmniSiMcpSchema(schema: OmniSiMcpTool['inputSchema']): string | undefined {
  if (!schema) {
    return undefined
  }
  try {
    return JSON.stringify(schema, null, 2)
  } catch {
    return undefined
  }
}
