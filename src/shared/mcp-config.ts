import {
  isMcpConfigInspectionNameWithinLimit,
  isMcpConfigInspectionTextWithinLimit,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from './mcp-config-inspection-limits'
import { summarizeMcpServer } from './mcp-server-inspection'
import {
  findOmniConsoleMcpName,
  findOmniSiMcpName,
  isOmniConsoleMcpNameUnavailable,
  OMNI_CONSOLE_MCP_NAME
} from './omni-console-mcp-alias'
import {
  omniConsoleMcpDefaultEntry,
  upgradeManagedOmniConsoleMcpEntry,
  type OmniConsoleMcpEntryOptions
} from './omni-console-mcp-ledger-headers'

export {
  isManagedOmniConsoleMcpEntry,
  isManagedOmniMcpEntry,
  isManagedOmniRogueMcpEntry,
  isManagedOmniSiMcpEntry,
  isOmniConsoleMcpHeadersHelperCommand,
  OMNI_CONSOLE_MCP_URL,
  OMNICONSOLE_DEFAULT_MCP_ENDPOINTS,
  OMNIROGUE_MCP_NAME,
  OMNIROGUE_MCP_URL,
  OMNIROGUE_UNIFIED_MCP_ENDPOINTS,
  OMNISI_MCP_NAME,
  OMNISI_MCP_URL,
  omniConsoleMcpDefaultEntry,
  omniConsoleMcpEntryNeedsLedgerHeaders,
  omniConsoleMcpHeadersHelperCommand,
  omniConsoleMcpHeadersKey,
  omniConsoleMcpLedgerHeaders,
  omniRogueUnifiedMcpDefaultEntry,
  upgradeManagedOmniConsoleMcpEntry,
  type OmniConsoleMcpConfigStyle,
  type OmniConsoleMcpEntryOptions
} from './omni-console-mcp-ledger-headers'

export { maskMcpEnv } from './mcp-server-inspection'

export type McpConfigFormat = 'workspace' | 'cursor' | 'claude' | 'gemini'

export type McpConfigCandidate = {
  format: McpConfigFormat
  label: string
  relativePath: string
  serversPath: string[]
}

export type McpConfigDirectoryEntry = {
  name: string
  isDirectory: boolean
}

export type McpServerTransport = 'stdio' | 'http' | 'unknown'
export type McpServerStatus = 'enabled' | 'disabled' | 'invalid'

export type McpServerSummary = {
  name: string
  transport: McpServerTransport
  status: McpServerStatus
  command?: string
  url?: string
  env?: Record<string, string>
  issue?: string
}

export type McpConfigInspection = {
  candidate: McpConfigCandidate
  exists: boolean
  status: 'missing' | 'valid' | 'invalid'
  servers: McpServerSummary[]
  error?: string
}

export const MCP_CONFIG_CANDIDATES: McpConfigCandidate[] = [
  {
    format: 'workspace',
    label: 'Workspace',
    relativePath: '.mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'cursor',
    label: 'Cursor',
    relativePath: '.cursor/mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude',
    relativePath: '.claude.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude workspace',
    relativePath: '.claude/mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'gemini',
    label: 'Gemini',
    relativePath: '.gemini/settings.json',
    serversPath: ['mcpServers']
  }
]

export { findOmniRogueMcpName, findOmniSiMcpName, isOmniRogueMcpConfigured, mergeOmniRogueUnifiedMcpConfig, OMNI_CONSOLE_MCP_NAME } from './omni-console-mcp-alias'

/** Provider OAuth owns authentication; this default contains only a public endpoint. */
export function mergeOmniConsoleMcpConfig(
  config: Record<string, unknown>,
  signedIn: boolean,
  provider: 'claude' | 'gemini' | 'muse' = 'claude',
  options: OmniConsoleMcpEntryOptions = {}
): Record<string, unknown> {
  if (!signedIn) {
    return config
  }
  const servers = extractObjectAtPath(config, ['mcpServers'])
  if (config.mcpServers !== undefined && !servers) {
    throw new Error('MCP server collection must be an object.')
  }
  const name = findOmniConsoleMcpName(config)
  if (name) {
    // Muse has no header shape to upgrade to, so an existing entry is always left as it is.
    if (isOmniConsoleMcpNameUnavailable(config, name) || provider === 'muse') {
      return config
    }
    // Why: an entry this app wrote in an older shape is rewritten to the current one (for a local
    // Claude spawn: the helper shape, so the login key stops moving per pane); a user's own
    // entry, e.g. one pinned with `X-Omni-Client`, is never touched.
    const upgraded = upgradeManagedOmniConsoleMcpEntry(servers?.[name], provider, options)
    if (!upgraded) {
      return config
    }
    return { ...config, mcpServers: { ...servers, [name]: upgraded } }
  }
  return {
    ...config,
    mcpServers: {
      ...servers,
      [OMNI_CONSOLE_MCP_NAME]: omniConsoleMcpDefaultEntry(provider, options)
    }
  }
}

export function isOmniConsoleMcpConfigured(config: Record<string, unknown>): boolean {
  return findOmniConsoleMcpName(config) !== null
}

export function isOmniSiMcpConfigured(config: Record<string, unknown>): boolean {
  return findOmniSiMcpName(config) !== null
}

export const MCP_STARTER_CONFIG = `{
  "mcpServers": {}
}
`

export function getMcpConfigParentDirs(
  candidates: readonly McpConfigCandidate[] = MCP_CONFIG_CANDIDATES
): string[] {
  return Array.from(
    new Set(
      candidates
        .map((candidate) => getRelativeParentDir(candidate.relativePath))
        .filter((parentDir) => parentDir !== '')
    )
  )
}

export function getMcpConfigCandidateParentDir(candidate: McpConfigCandidate): string {
  return getRelativeParentDir(candidate.relativePath)
}

export function selectExistingMcpConfigCandidates(
  entriesByRelativeDir: ReadonlyMap<string, readonly McpConfigDirectoryEntry[]>,
  candidates: readonly McpConfigCandidate[] = MCP_CONFIG_CANDIDATES
): McpConfigCandidate[] {
  return candidates.filter((candidate) => {
    const parentDir = getRelativeParentDir(candidate.relativePath)
    const basename = getRelativeBasename(candidate.relativePath)
    const entries = entriesByRelativeDir.get(parentDir) ?? []
    return entries.some((entry) => entry.name === basename && !entry.isDirectory)
  })
}

export function canInspectLocalMcpConfigRoot(rootPath: string, isWindowsHost: boolean): boolean {
  if (isWindowsHost) {
    return true
  }
  return !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(rootPath)
}

export function inspectMcpConfigContent(
  candidate: McpConfigCandidate,
  content: string | null
): McpConfigInspection {
  if (content === null) {
    return { candidate, exists: false, status: 'missing', servers: [] }
  }
  if (!isMcpConfigInspectionTextWithinLimit(content)) {
    return {
      candidate,
      exists: true,
      status: 'invalid',
      servers: [],
      error: 'MCP config exceeds the inspection size limit.'
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    return {
      candidate,
      exists: true,
      status: 'invalid',
      servers: [],
      error: error instanceof Error ? error.message : 'Invalid JSON'
    }
  }

  const rawServers = extractObjectAtPath(parsed, candidate.serversPath)
  if (!rawServers) {
    return { candidate, exists: true, status: 'valid', servers: [] }
  }
  const serverEntries = collectMcpServerEntries(rawServers)
  if (!serverEntries) {
    return {
      candidate,
      exists: true,
      status: 'invalid',
      servers: [],
      error: 'MCP server collection exceeds the inspection limits.'
    }
  }

  return {
    candidate,
    exists: true,
    status: 'valid',
    servers: serverEntries.map(([name, entry]) => summarizeMcpServer(name, entry))
  }
}

function collectMcpServerEntries(rawServers: Record<string, unknown>): [string, unknown][] | null {
  const entries: [string, unknown][] = []
  for (const name in rawServers) {
    if (!Object.hasOwn(rawServers, name)) {
      continue
    }
    if (
      entries.length >= MCP_CONFIG_INSPECTION_MAX_SERVERS ||
      !isMcpConfigInspectionNameWithinLimit(name)
    ) {
      return null
    }
    entries.push([name, rawServers[name]])
  }
  return entries
}

function getRelativeParentDir(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex === -1 ? '' : normalizedPath.slice(0, separatorIndex)
}

function getRelativeBasename(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex === -1 ? normalizedPath : normalizedPath.slice(separatorIndex + 1)
}

function extractObjectAtPath(
  value: unknown,
  pathSegments: string[]
): Record<string, unknown> | null {
  let current = value
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null
}
