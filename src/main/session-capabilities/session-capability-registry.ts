import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { McpConfigCandidate } from '../../shared/mcp-config'
import { MCP_CONFIG_INSPECTION_MAX_BYTES } from '../../shared/mcp-config-inspection-limits'
import {
  probeSessionCapabilities,
  type SessionCapabilities,
  type SessionCapabilityProbeInput
} from '../../shared/session-capabilities'

const MAX_TRACKED_PANES = 1024
const capabilitiesByPaneKey = new Map<string, SessionCapabilities>()
// Why: a reattach or respawn can race an older probe; only the newest probe per pane may land.
const probeGenerationByPaneKey = new Map<string, number>()
let probeGeneration = 0

/** Only a genuinely missing path is absent; ENOTDIR means something occupies the way to it. */
const ABSENT_FILE_CODES = new Set(['ENOENT'])

/** Absent resolves null; every other failure rejects, so it reads as unknown and never as none. */
export async function readMcpConfigCandidate(
  cwd: string,
  candidate: McpConfigCandidate
): Promise<string | null> {
  const filePath = path.join(cwd, ...candidate.relativePath.split('/'))
  const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (ABSENT_FILE_CODES.has(error?.code ?? '')) {
      return null
    }
    throw error
  })
  if (!info) {
    return null
  }
  // Why: a path that exists but is no regular file was never read; absent would claim no servers.
  if (!info.isFile()) {
    throw new Error(`MCP config is not a regular file: ${filePath}`)
  }
  if (info.size > MCP_CONFIG_INSPECTION_MAX_BYTES) {
    throw new Error(`MCP config exceeds the inspection size limit: ${filePath}`)
  }
  return await readFile(filePath, 'utf8')
}

export type SessionCapabilityLaunch = Omit<SessionCapabilityProbeInput, 'readCandidate' | 'env'> & {
  env: Readonly<Record<string, string | undefined>> | undefined
}

/** Probes in the background; a spawn never waits on, or fails because of, the probe. */
export function recordSessionCapabilitiesForPane(
  paneKey: string | null,
  launch: SessionCapabilityLaunch,
  readCandidate: SessionCapabilityProbeInput['readCandidate'] = readMcpConfigCandidate
): Promise<void> {
  if (!paneKey) {
    return Promise.resolve()
  }
  const generation = ++probeGeneration
  probeGenerationByPaneKey.set(paneKey, generation)
  // Why: the PTY inherits main's environment, with the launch's own overrides on top.
  const env = launch.connectionId ? {} : { ...process.env, ...launch.env }
  return probeSessionCapabilities({ ...launch, env, readCandidate })
    .then((capabilities) => {
      if (probeGenerationByPaneKey.get(paneKey) !== generation) {
        return
      }
      capabilitiesByPaneKey.delete(paneKey)
      capabilitiesByPaneKey.set(paneKey, capabilities)
      while (capabilitiesByPaneKey.size > MAX_TRACKED_PANES) {
        const oldest = capabilitiesByPaneKey.keys().next().value
        if (oldest === undefined) {
          break
        }
        capabilitiesByPaneKey.delete(oldest)
        probeGenerationByPaneKey.delete(oldest)
      }
    })
    .catch(() => {})
}

export function getSessionCapabilitiesForPane(paneKey: string): SessionCapabilities | null {
  return capabilitiesByPaneKey.get(paneKey) ?? null
}

export function forgetSessionCapabilitiesForPane(paneKey: string): void {
  capabilitiesByPaneKey.delete(paneKey)
  probeGenerationByPaneKey.delete(paneKey)
}

export function resetSessionCapabilityRegistryForTests(): void {
  capabilitiesByPaneKey.clear()
  probeGenerationByPaneKey.clear()
  probeGeneration = 0
}
