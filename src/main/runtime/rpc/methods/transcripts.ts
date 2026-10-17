// ─── transcripts.buildDeliverable ───────────────────────────────────────────
// Builds the redacted transcript a person handoff delivers, on the host that
// owns the session.
//
// The placement is the point. The session's messages — file contents, command
// output, anything the agent read — never cross a process boundary: the host
// reads them, renders the document, and runs the redaction gate locally. What
// leaves is either a file already proven clean, or a refusal.
//
// Nothing derived from host state crosses back as prose. A failure answers with
// a fixed code from a closed set, because a reader error carries the transcript
// path, and a path is a value: `~/.claude/projects/<token-shaped dir>/…` inside
// an EACCES message would walk a secret straight through the gate the file
// itself is held to. Exception messages are contained here and never forwarded.
// The method is deliberately absent from the mobile allowlist.

import { z } from 'zod'
import {
  TRANSCRIPT_ERROR_CODES,
  TRANSCRIPT_REFUSAL_REASON,
  type TranscriptDeliverableRpcResult
} from '../../../../shared/conversation-transcript-deliverable'
import { buildSessionTranscript } from '../../../transcripts/session-transcript-deliverable'
import { defineMethod, type RpcMethod } from '../core'
import { COMPLETE_TRANSCRIPT_METHOD } from './complete-transcripts'

/** A session longer than this delivers its most recent messages, and the
 *  document says so in its header and footer. */
export const TRANSCRIPT_DELIVERABLE_MAX_MESSAGES = 5000

// Not streaming: one request, one answer — either a clean file or a refusal.
export const TRANSCRIPT_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: 'transcripts.buildDeliverable',
    params: z.object({
      agent: z.string().min(1),
      sessionId: z.string().min(1),
      transcriptPath: z.string().min(1).optional(),
      /** ISO 8601 dispatch time; dates the file name and the header. */
      capturedAt: z.string().min(1),
      model: z.string().min(1).nullable().optional(),
      /** The SSH connection the session belongs to, or null for this host.
       *  Required so a session on another machine is refused rather than
       *  silently answered from this host's own transcript directory. */
      expectedConnectionId: z.string().min(1).nullable()
    }),
    handler: async (params, { signal }): Promise<TranscriptDeliverableRpcResult> => {
      if (params.expectedConnectionId !== null) {
        // This reader resolves paths on the machine it runs on; it has no way
        // to read the session that lives behind an SSH connection, and a local
        // file at the same path would be a different machine's conversation.
        return { error: TRANSCRIPT_ERROR_CODES.remoteHostUnsupported }
      }
      // The assembly is shared with the employee transcript uploader; this method
      // only shapes its answer for the wire.
      const built = await buildSessionTranscript(
        {
          agent: params.agent,
          sessionId: params.sessionId,
          ...(params.transcriptPath ? { transcriptPath: params.transcriptPath } : {}),
          capturedAt: params.capturedAt,
          ...(params.model === undefined ? {} : { model: params.model }),
          limit: TRANSCRIPT_DELIVERABLE_MAX_MESSAGES
        },
        signal
      )
      if (built.kind === 'refused') {
        return { reason: TRANSCRIPT_REFUSAL_REASON, redactions: built.redactions }
      }
      if (built.kind === 'error') {
        return built.sizeBytes === undefined
          ? { error: built.code }
          : { error: built.code, sizeBytes: built.sizeBytes }
      }
      return {
        name: built.deliverable.name,
        contentBase64: built.deliverable.bytes.toString('base64'),
        sha256: built.deliverable.sha256,
        size: built.deliverable.size,
        messageCount: built.deliverable.messageCount,
        truncatedBlocks: built.deliverable.truncatedBlocks,
        earlierMessagesOmitted: built.earlierMessagesOmitted,
        omittedRecords: built.omittedRecords
      }
    }
  }),
  COMPLETE_TRANSCRIPT_METHOD
]
