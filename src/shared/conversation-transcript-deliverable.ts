// The wire shape of `transcripts.buildDeliverable`. Both ends parse the same
// schema so a host that answers a different shape is caught at the boundary
// rather than producing a transcript nobody verified.
//
// A failure is a code from a closed set, never a message built on the host. A
// reader error names the transcript path, and a path is a value: the gate that
// refuses a key inside the file would be pointless if the same key could ride
// out in an EACCES string. The client maps a code to its own fixed sentence.

import { z } from 'zod'

export const TRANSCRIPT_REFUSAL_REASON = 'transcript_contains_protected_data'

export const TRANSCRIPT_ERROR_CODES = {
  unavailable: 'transcript_unavailable',
  empty: 'transcript_empty',
  tooLarge: 'transcript_too_large',
  buildFailed: 'transcript_build_failed',
  incomplete: 'transcript_incomplete',
  remoteHostUnsupported: 'transcript_remote_host_unsupported'
} as const

export type TranscriptErrorCode =
  (typeof TRANSCRIPT_ERROR_CODES)[keyof typeof TRANSCRIPT_ERROR_CODES]

const errorCode = z.enum([
  TRANSCRIPT_ERROR_CODES.unavailable,
  TRANSCRIPT_ERROR_CODES.empty,
  TRANSCRIPT_ERROR_CODES.tooLarge,
  TRANSCRIPT_ERROR_CODES.buildFailed,
  TRANSCRIPT_ERROR_CODES.incomplete,
  TRANSCRIPT_ERROR_CODES.remoteHostUnsupported
])

export const transcriptDeliverableRpcResult = z.union([
  z
    .object({
      name: z.string().min(1).max(255),
      contentBase64: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z
        .number()
        .int()
        .nonnegative()
        .max(10 * 1024 * 1024),
      messageCount: z.number().int().nonnegative(),
      truncatedBlocks: z.number().int().nonnegative(),
      earlierMessagesOmitted: z.boolean(),
      omittedRecords: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      reason: z.literal(TRANSCRIPT_REFUSAL_REASON),
      redactions: z.number().int().nonnegative()
    })
    .strict(),
  // `sizeBytes` is a length, not a value, and only accompanies `too_large`.
  z.object({ error: errorCode, sizeBytes: z.number().int().nonnegative().optional() }).strict()
])

export type TranscriptDeliverableRpcResult = z.infer<typeof transcriptDeliverableRpcResult>

/** The client's own wording for a host code. Fixed sentences: nothing here is
 *  built from host state. */
export function transcriptErrorMessage(code: TranscriptErrorCode, sizeBytes?: number): string {
  switch (code) {
    case TRANSCRIPT_ERROR_CODES.unavailable:
      return 'The source host could not read this session’s transcript. Try the handoff again, or send the work files instead.'
    case TRANSCRIPT_ERROR_CODES.empty:
      return 'This session has no readable transcript yet.'
    case TRANSCRIPT_ERROR_CODES.tooLarge:
      return sizeBytes
        ? `This session’s transcript is ${Math.round(sizeBytes / (1024 * 1024))} MiB, above the limit for a handoff transcript. Send the work files instead; it was not truncated.`
        : 'This session’s transcript is above the limit for a handoff transcript. Send the work files instead; it was not truncated.'
    case TRANSCRIPT_ERROR_CODES.remoteHostUnsupported:
      return 'A session running over SSH cannot send its transcript yet: it lives on the remote machine. Send the work files instead.'
    case TRANSCRIPT_ERROR_CODES.buildFailed:
      return 'The source host could not build this session’s transcript. Send the work files instead.'
    case TRANSCRIPT_ERROR_CODES.incomplete:
      return 'The source host could not verify the complete session history. No partial transcript was sent. Reconnect or update that host, then retry.'
  }
}
