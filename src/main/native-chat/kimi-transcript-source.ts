import { posix, win32 } from 'node:path'

export const MAX_KIMI_TRANSCRIPT_STATE_BYTES = 1024 * 1024

export type KimiTranscriptSourceAccess = {
  /** Read a complete file on the owning host, refusing files larger than maxBytes. */
  readFile: (filePath: string, maxBytes: number) => Promise<Buffer>
  signal?: AbortSignal
}

export type KimiTranscriptSource = {
  filePath: string
  format: 'jsonl'
  statePath?: string
  agentId?: string
}

export async function resolveKimiTranscriptSource(
  args: { transcriptPath: string; sessionId?: string },
  access: KimiTranscriptSourceAccess
): Promise<KimiTranscriptSource> {
  access.signal?.throwIfAborted()
  const filePath = args.transcriptPath
  const paths = owningHostPaths(filePath)
  if (!paths.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new Error('Kimi capture requires an absolute transcript path on its owning host.')
  }
  if (paths.extname(filePath) === '.jsonl') {
    return { filePath, format: 'jsonl' }
  }
  if (paths.basename(filePath) !== 'state.json') {
    throw new Error('Kimi capture requires its state.json or authoritative JSONL transcript.')
  }
  if (filePath.split(/[\\/]/).includes('..')) {
    throw new Error('Kimi state paths must not contain parent-directory components.')
  }
  const sessionDir = paths.dirname(filePath)
  if (args.sessionId && paths.basename(sessionDir) !== args.sessionId) {
    throw new Error('Kimi state path belongs to a different source session.')
  }

  const bytes = await access.readFile(filePath, MAX_KIMI_TRANSCRIPT_STATE_BYTES)
  access.signal?.throwIfAborted()
  if (bytes.length > MAX_KIMI_TRANSCRIPT_STATE_BYTES) {
    throw new Error('Kimi session metadata exceeds the complete capture limit.')
  }
  const state = parseState(bytes)
  if (args.sessionId && typeof state.id === 'string' && state.id !== args.sessionId) {
    throw new Error('Kimi session metadata belongs to a different source session.')
  }
  const agents = asRecord(state.agents)
  if (!agents) {
    throw new Error('Kimi session metadata has no authoritative agent map.')
  }
  const primaryAgents = Object.entries(agents).filter(([, value]) => {
    const agent = asRecord(value)
    const labels = asRecord(agent?.labels)
    return (
      agent?.type === 'main' &&
      agent.parentAgentId == null &&
      (labels?.parentAgentId == null || labels.parentAgentId === '')
    )
  })
  if (primaryAgents.length !== 1) {
    throw new Error('Kimi session metadata must identify exactly one primary agent.')
  }
  const agentId = primaryAgents[0][0]
  // Embedded homedir and forkedFrom may describe another host or copied history.
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new Error('Kimi session metadata contains an invalid primary agent identifier.')
  }
  return {
    filePath: paths.join(sessionDir, 'agents', agentId, 'wire.jsonl'),
    format: 'jsonl',
    statePath: filePath,
    agentId
  }
}

function owningHostPaths(filePath: string): typeof posix {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^[\\/]{2}/.test(filePath) ? win32 : posix
}

function parseState(bytes: Buffer): Record<string, unknown> {
  let state: Record<string, unknown> | null
  try {
    state = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (cause) {
    throw new Error('Kimi session metadata is not valid UTF-8 JSON.', { cause })
  }
  if (!state) {
    throw new Error('Kimi session metadata must be a JSON object.')
  }
  return state
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
