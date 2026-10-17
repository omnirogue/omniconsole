import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import { resolveOpenCodeTranscriptSnapshot } from './opencode-transcript-snapshot'
import { readTranscriptFilePage } from './transcript-page-reader'

export async function readOpenCodeTranscriptPage(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal,
  options?: { maxPayloadBytes?: number }
): Promise<NativeChatTranscriptPageResult> {
  const source = { connectionId: args.connectionId ?? null }
  try {
    const filePath = await resolveOpenCodeTranscriptSnapshot(args, signal)
    return await readTranscriptFilePage({ ...args, transcriptPath: filePath }, signal, options)
  } catch (error) {
    signal?.throwIfAborted()
    return {
      source,
      error: error instanceof Error ? error.message : String(error),
      ...((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { notFound: true as const } : {})
    }
  }
}
