import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import { resolveIndexedTranscriptFilePath } from './indexed-transcript-source'
import { resolveSessionFilePath } from './session-file-resolver'
import { resolveProviderTranscriptSource } from './provider-transcript-source'
import { openTranscriptPageSource } from './transcript-page-source'
import { readTranscriptFilePage } from './transcript-page-reader'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'

export async function dispatchTranscriptPage(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptPageResult> {
  const source = { connectionId: args.connectionId ?? null }
  try {
    signal?.throwIfAborted()
    if (
      args.cursor &&
      (args.cursor.agent !== args.agent ||
        args.cursor.sessionId !== args.sessionId ||
        args.cursor.connectionId !== source.connectionId ||
        (args.cursor.originPath &&
          args.transcriptPath &&
          args.cursor.originPath !== args.transcriptPath))
    ) {
      throw new Error('Transcript cursor belongs to a different source session.')
    }
    if (args.agent === 'opencode') {
      return await readOpenCode(args, signal)
    }
    const requestedPath = args.transcriptPath ?? args.cursor?.originPath
    let transcriptPath = requestedPath ?? args.cursor?.filePath ?? (await resolvePath(args, signal))
    if (!transcriptPath) {
      return { source, error: 'Transcript unavailable on its owning host.', notFound: true }
    }
    const originPath = transcriptPath
    transcriptPath = (
      await resolveProviderTranscriptSource(
        { transcriptPath, sessionId: args.sessionId, agent: args.agent },
        {
          signal,
          readFile: (filePath, maxBytes) =>
            readMetadata({ ...args, cursor: undefined, transcriptPath: filePath }, maxBytes, signal)
        }
      )
    ).filePath
    const result = await readTranscriptFilePage({ ...args, transcriptPath }, signal)
    if (!('error' in result)) {
      if (result.cursor && originPath !== transcriptPath) {
        result.cursor.originPath = originPath
      }
      if (args.agent === 'kimi') {
        result.warnings = [
          'Kimi attachment blob references are preserved; separate media blob files are not included in the transcript.'
        ]
      }
    }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    return { source, error: error instanceof Error ? error.message : String(error) }
  }
}

async function resolvePath(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<string | null> {
  if (args.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const authority = getSshProviderAuthority(args.connectionId)
    if (!provider.transcripts) {
      throw new Error('Update the SSH relay to resolve provider transcripts on their owning host.')
    }
    const filePath = await provider.transcripts.resolveSource(args.agent, args.sessionId, signal)
    signal?.throwIfAborted()
    if (!isCurrentSshProviderAuthority(authority)) {
      throw new Error('Transcript source connection changed during provider lookup. Retry capture.')
    }
    return filePath
  }
  const nativePath = await resolveSessionFilePath(args.agent, args.sessionId, {}, signal)
  return (
    nativePath ??
    resolveIndexedTranscriptFilePath(args.agent, args.sessionId, {
      signal,
      listSessions: async (params, options) =>
        (await import('../ai-vault/cached-session-list')).listAiVaultSessions(params, options)
    })
  )
}

async function readOpenCode(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptPageResult> {
  if (!args.connectionId) {
    return (await import('./opencode-transcript-page')).readOpenCodeTranscriptPage(args, signal)
  }
  const provider = requireSshFilesystemProvider(args.connectionId)
  const authority = getSshProviderAuthority(args.connectionId)
  if (!provider.transcripts) {
    throw new Error('Update the SSH relay to capture OpenCode transcripts on their owning host.')
  }
  const result = await provider.transcripts.readOpenCodePage(args, signal)
  signal?.throwIfAborted()
  if (!isCurrentSshProviderAuthority(authority)) {
    throw new Error('Transcript source connection changed during OpenCode capture. Retry capture.')
  }
  return {
    ...result,
    source: { connectionId: args.connectionId },
    ...(!('error' in result) && result.cursor
      ? { cursor: { ...result.cursor, connectionId: args.connectionId } }
      : {})
  }
}

async function readMetadata(
  args: NativeChatTranscriptPageArgs,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const file = await openTranscriptPageSource(args, signal)
  if (!file) {
    throw new Error('Provider session metadata is unavailable on its owning host.')
  }
  try {
    const before = await file.stat()
    if (before.size > maxBytes) {
      throw new Error('Provider session metadata exceeds the complete capture limit.')
    }
    const parts: Buffer[] = []
    for (let offset = 0; offset < before.size;) {
      const length = Math.min(MAX_FILE_RANGE_READ_BYTES, before.size - offset)
      const bytes = await file.read(offset, length)
      if (bytes.length !== length) {
        throw new Error('Provider session metadata changed during capture.')
      }
      parts.push(bytes)
      offset += length
    }
    const after = await file.stat()
    if (
      before.identity !== after.identity ||
      before.size !== after.size ||
      before.modifiedAt !== after.modifiedAt
    ) {
      throw new Error('Provider session metadata changed during capture.')
    }
    return Buffer.concat(parts)
  } finally {
    await file.close()
  }
}
