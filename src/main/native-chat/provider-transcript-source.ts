import { posix, win32 } from 'node:path'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { resolveKimiTranscriptSource } from './kimi-transcript-source'

export const MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES = 1024 * 1024

export type ProviderTranscriptSourceAccess = {
  /** Read a complete file on the owning host, refusing files larger than maxBytes. */
  readFile: (filePath: string, maxBytes: number) => Promise<Buffer>
  signal?: AbortSignal
}

export type ProviderTranscriptSource = {
  filePath: string
  format: 'json' | 'jsonl'
}

export async function resolveProviderTranscriptSource(
  args: { agent: string; sessionId: string; transcriptPath: string },
  access?: ProviderTranscriptSourceAccess
): Promise<ProviderTranscriptSource> {
  access?.signal?.throwIfAborted()
  const filePath = args.transcriptPath
  const paths = /^[A-Za-z]:[\\/]/.test(filePath) || /^[\\/]{2}/.test(filePath) ? win32 : posix
  if (!paths.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new Error('Capture requires an absolute transcript path on its owning host.')
  }
  // Exact hook paths can name rotated or legacy files outside the indexed layout.
  if (paths.extname(filePath) === '.jsonl') {
    return { filePath, format: 'jsonl' }
  }
  const fileName = paths.basename(filePath)
  const sessionDir = paths.dirname(filePath)

  if (args.agent === 'grok' || args.agent === 'rovo' || args.agent === 'cline') {
    if (filePath.split(/[\\/]/).includes('..')) {
      throw new Error('Indexed transcript paths must not contain parent-directory components.')
    }
    const directoryId = paths.basename(sessionDir)
    const pathSessionId = args.agent === 'grok' ? sessionIdFromPath(sessionDir, paths) : directoryId
    const metadataName =
      args.agent === 'grok'
        ? 'summary.json'
        : args.agent === 'rovo'
          ? 'metadata.json'
          : `${directoryId}.json`
    const historyName =
      args.agent === 'grok'
        ? 'chat_history.jsonl'
        : args.agent === 'rovo'
          ? 'session_context.json'
          : `${directoryId}.messages.json`
    const format = args.agent === 'grok' ? 'jsonl' : 'json'
    if (fileName === historyName && pathSessionId === args.sessionId) {
      return { filePath, format }
    }
    if (fileName !== metadataName && fileName !== historyName) {
      throw new Error(
        `The ${args.agent} source is not its indexed metadata or conversation history.`
      )
    }
    if (args.agent === 'rovo' && directoryId !== args.sessionId) {
      throw new Error('Transcript path belongs to a different source session.')
    }
    const metadataPath = fileName === metadataName ? filePath : paths.join(sessionDir, metadataName)
    const metadata = await readMetadata(metadataPath, requireAccess(access))
    const declaredId =
      args.agent === 'grok'
        ? asRecord(metadata.info)?.id
        : args.agent === 'cline'
          ? metadata.session_id
          : undefined
    assertMetadataSession(declaredId, pathSessionId, args.sessionId)
    // The scanner's companion path is fixed; embedded paths never redirect capture.
    return { filePath: paths.join(sessionDir, historyName), format }
  }

  if (args.agent === 'kimi' && paths.extname(filePath) !== '.jsonl') {
    const resolved = await resolveKimiTranscriptSource(args, requireAccess(access))
    return { filePath: resolved.filePath, format: resolved.format }
  }
  if (paths.extname(filePath) === '.json') {
    // Full documents are validated by the paginated reader, outside the metadata cap.
    return { filePath, format: 'json' }
  }
  throw new Error('Complete transcript capture requires a JSON or JSONL source.')
}

function requireAccess(access?: ProviderTranscriptSourceAccess): ProviderTranscriptSourceAccess {
  if (!access) {
    throw new Error('Resolving session metadata requires access to its owning host.')
  }
  return access
}

async function readMetadata(
  filePath: string,
  access: ProviderTranscriptSourceAccess
): Promise<Record<string, unknown>> {
  const bytes = await access.readFile(filePath, MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES)
  access.signal?.throwIfAborted()
  if (bytes.length > MAX_PROVIDER_TRANSCRIPT_METADATA_BYTES) {
    throw new Error('Session metadata exceeds the complete capture limit.')
  }
  let record: Record<string, unknown> | null
  try {
    record = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (cause) {
    throw new Error('Session metadata is not valid UTF-8 JSON.', { cause })
  }
  if (!record) {
    throw new Error('Session metadata must be a JSON object.')
  }
  return record
}

function assertMetadataSession(value: unknown, pathSessionId: string, sessionId: string): void {
  const declaredId = typeof value === 'string' ? value.trim() : ''
  if (
    !sessionId ||
    (value != null && typeof value !== 'string') ||
    (declaredId || pathSessionId) !== sessionId
  ) {
    throw new Error('Session metadata belongs to a different source session.')
  }
}

function sessionIdFromPath(filePath: string, paths: typeof posix): string {
  const stem = paths.basename(filePath, paths.extname(filePath))
  return stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? stem
}
