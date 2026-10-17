import {
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES,
  type McpConfigCandidate
} from './mcp-config'

/** Provider families whose credentials a session can reach. Ids double as logo keys. */
export const SESSION_PROVIDER_KEY_ENV_NAMES = {
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  xai: ['XAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
  fal: ['FAL_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  replicate: ['REPLICATE_API_TOKEN']
} as const satisfies Record<string, readonly string[]>

export type SessionProviderId = keyof typeof SESSION_PROVIDER_KEY_ENV_NAMES

export type SessionProviderKeyPresence = {
  provider: SessionProviderId
  /** Env var NAMES that are set. Values are never read past a presence check. */
  envNames: string[]
}

export type SessionMcpServerName = { name: string; source: string }

/** What a session could use at launch. `unknown` means the execution host did not report it. */
export type SessionCapabilities = {
  host: 'local' | 'remote'
  providers: SessionProviderKeyPresence[] | 'unknown'
  mcpServers: SessionMcpServerName[] | 'unknown'
  probedAt: number
}

export const SESSION_CAPABILITY_MAX_MCP_SERVERS = 64

export function detectProviderKeyPresence(
  env: Readonly<Record<string, string | undefined>>,
  envToDelete: readonly string[] = []
): SessionProviderKeyPresence[] {
  const deleted = new Set(envToDelete)
  const presence: SessionProviderKeyPresence[] = []
  for (const [provider, names] of Object.entries(SESSION_PROVIDER_KEY_ENV_NAMES)) {
    const envNames = names.filter((name) => !deleted.has(name) && Boolean(env[name]?.trim()))
    if (envNames.length > 0) {
      presence.push({ provider: provider as SessionProviderId, envNames })
    }
  }
  return presence
}

/** Names plus whether a source went unread, so "none" is never inferred from a failure. */
export type McpServerNameCollection = { names: SessionMcpServerName[]; incomplete: boolean }

/**
 * Server names from each candidate's content; null content means the file is absent.
 * Content that cannot be inspected marks the collection incomplete rather than reading as none.
 */
export function collectMcpServerNames(
  contents: readonly {
    candidate: McpConfigCandidate
    content: string | null
  }[]
): McpServerNameCollection {
  const seen = new Set<string>()
  const names: SessionMcpServerName[] = []
  let incomplete = false
  for (const { candidate, content } of contents) {
    const inspection = inspectMcpConfigContent(candidate, content)
    incomplete ||= inspection.status === 'invalid'
    for (const server of inspection.servers) {
      if (server.status === 'disabled' || seen.has(server.name)) {
        continue
      }
      seen.add(server.name)
      // Why: the cap bounds what is shown, so scanning continues — a later source may be unreadable.
      if (names.length < SESSION_CAPABILITY_MAX_MCP_SERVERS) {
        names.push({ name: server.name, source: candidate.label })
      }
    }
  }
  return { names, incomplete }
}

export type SessionCapabilityProbeInput = {
  cwd: string | undefined
  env: Readonly<Record<string, string | undefined>>
  envToDelete?: readonly string[]
  /** SSH-spawned sessions run elsewhere; this host's env and files say nothing about them. */
  connectionId?: string | null
  /** Reads a candidate relative to cwd; resolves null when absent, rejects when unreadable. */
  readCandidate: (cwd: string, candidate: McpConfigCandidate) => Promise<string | null>
  now?: () => number
}

export async function probeSessionCapabilities(
  input: SessionCapabilityProbeInput
): Promise<SessionCapabilities> {
  const probedAt = (input.now ?? Date.now)()
  if (input.connectionId) {
    return {
      host: 'remote',
      providers: 'unknown',
      mcpServers: 'unknown',
      probedAt
    }
  }
  const cwd = input.cwd
  let refused = false
  const contents = cwd
    ? await Promise.all(
        MCP_CONFIG_CANDIDATES.map(async (candidate) => ({
          candidate,
          content: await input.readCandidate(cwd, candidate).catch(() => {
            refused = true
            return null
          })
        }))
      )
    : null
  const collected = contents ? collectMcpServerNames(contents) : null
  // Why: a refused or unreadable config is not an absent one, and names found elsewhere do not
  // cover for it — a partial list reads as the whole truth, so only a full answer may be shown.
  const answered = collected ? !refused && !collected.incomplete : false
  return {
    host: 'local',
    providers: detectProviderKeyPresence(input.env, input.envToDelete),
    mcpServers: collected && answered ? collected.names : 'unknown',
    probedAt
  }
}

const PROVIDER_IDS = new Set(Object.keys(SESSION_PROVIDER_KEY_ENV_NAMES))

/** Validates the IPC reply so a stale or mismatched host cannot put arbitrary shapes in the UI. */
export function normalizeSessionCapabilities(value: unknown): SessionCapabilities | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (raw.host !== 'local' && raw.host !== 'remote') {
    return null
  }
  const providers =
    raw.providers === 'unknown'
      ? 'unknown'
      : Array.isArray(raw.providers)
        ? raw.providers.flatMap((entry): SessionProviderKeyPresence[] => {
            const item = entry as Partial<SessionProviderKeyPresence> | null
            return item &&
              typeof item.provider === 'string' &&
              PROVIDER_IDS.has(item.provider) &&
              Array.isArray(item.envNames)
              ? [
                  {
                    provider: item.provider,
                    envNames: item.envNames.filter((name) => typeof name === 'string')
                  }
                ]
              : []
          })
        : 'unknown'
  const mcpServers =
    raw.mcpServers === 'unknown'
      ? 'unknown'
      : Array.isArray(raw.mcpServers)
        ? raw.mcpServers
            .flatMap((entry): SessionMcpServerName[] => {
              const item = entry as Partial<SessionMcpServerName> | null
              return item && typeof item.name === 'string' && typeof item.source === 'string'
                ? [{ name: item.name, source: item.source }]
                : []
            })
            .slice(0, SESSION_CAPABILITY_MAX_MCP_SERVERS)
        : 'unknown'
  return {
    host: raw.host,
    providers,
    mcpServers,
    probedAt: typeof raw.probedAt === 'number' ? raw.probedAt : 0
  }
}
