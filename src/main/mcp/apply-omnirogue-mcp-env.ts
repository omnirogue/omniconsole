import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { OMNIROGUE_MCP_URL, OMNISI_MCP_URL } from '../../shared/mcp-config'
import { prepareOmniConsoleMcpForPty } from './omni-console-mcp-pty'

export type OmniRogueMcpEnvInput = {
  env: NodeJS.ProcessEnv
  cwd?: string
  launchAgent?: TuiAgent
  isWsl?: boolean
  wslDistro?: string | null
  userDataPath?: string
  claudeHeadersHelper?: string | null
}

export type OmniRogueMcpAccountState = {
  connected: boolean
  apiOrigin: string
  token: string | null
}

let accountState: OmniRogueMcpAccountState = {
  connected: false,
  apiOrigin: 'https://api.omnirogue.com',
  token: null
}

export function setOmniRogueMcpAccountState(next: Partial<OmniRogueMcpAccountState>): void {
  accountState = {
    ...accountState,
    ...next
  }
}

export function getOmniRogueMcpAccountState(): OmniRogueMcpAccountState {
  return { ...accountState }
}

function readStoredOmniRogueToken(userDataPath?: string): string | null {
  if (!userDataPath) {
    return null
  }
  try {
    const roomsDir = join(userDataPath, 'rooms')
    const files = readdirSync(roomsDir).filter((file) => file.endsWith('-credential.json'))
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(roomsDir, file), 'utf8')) as {
        token?: unknown
      }
      if (typeof raw?.token === 'string' && raw.token.trim().length > 0) {
        return raw.token.trim()
      }
    }
  } catch {
    // Missing rooms directory or unreadable credential file means not linked on disk.
  }
  return null
}

export function isOmniRogueMcpAccountConnected(input: OmniRogueMcpEnvInput): boolean {
  if (accountState.connected) {
    return true
  }
  if (
    input.env.OMNIROGUE_MCP_ENABLED === '1' ||
    Boolean(input.env.OMNIROGUE_DEVICE_TOKEN?.trim()) ||
    Boolean(input.env.OMNIROGUE_API_KEY?.trim())
  ) {
    return true
  }
  return readStoredOmniRogueToken(input.userDataPath) !== null
}

/**
 * Auto-provisions the unified OmniRogue + OmniSI MCP connector configuration
 * and environment variables for a local or SSH-relay PTY launch when an
 * OmniRogue account is connected.
 */
export function applyOmniRogueMcpEnv(input: OmniRogueMcpEnvInput): void {
  if (!isOmniRogueMcpAccountConnected(input)) {
    return
  }
  const token = accountState.token ?? readStoredOmniRogueToken(input.userDataPath)
  input.env.OMNIROGUE_MCP_URL ??= OMNIROGUE_MCP_URL
  input.env.OMNISI_MCP_URL ??= OMNISI_MCP_URL
  input.env.OMNIROGUE_UNIFIED_MCP ??= '1'
  if (token && !input.env.OMNIROGUE_DEVICE_TOKEN) {
    input.env.OMNIROGUE_DEVICE_TOKEN = token
  }
  prepareOmniConsoleMcpForPty({
    ...input,
    includeOmniRogueUnified: true
  })
}

