import { TRANSCRIPT_ERROR_CODES } from '../../shared/conversation-transcript-deliverable'
import {
  buildTranscriptFromMessages,
  type SessionTranscriptBuild
} from './session-transcript-deliverable'
import {
  CompleteTranscriptTooLargeError,
  readCompleteSessionTranscript,
  type CompleteTranscriptSource
} from './complete-session-transcript-reader'

/** Reuses the existing transcript render/redaction gate, with complete history and whole tool payloads. */
export async function buildCompleteSessionTranscript(
  source: CompleteTranscriptSource & { capturedAt: string },
  signal?: AbortSignal
): Promise<SessionTranscriptBuild> {
  try {
    const messages = await readCompleteSessionTranscript(source, signal)
    signal?.throwIfAborted()
    return buildTranscriptFromMessages({ ...source, clipToolPayloads: false }, messages)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return {
      kind: 'error',
      code:
        error instanceof CompleteTranscriptTooLargeError
          ? TRANSCRIPT_ERROR_CODES.tooLarge
          : TRANSCRIPT_ERROR_CODES.incomplete
    }
  }
}
