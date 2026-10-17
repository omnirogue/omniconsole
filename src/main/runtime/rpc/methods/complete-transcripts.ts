import { z } from 'zod'
import {
  TRANSCRIPT_REFUSAL_REASON,
  type TranscriptDeliverableRpcResult
} from '../../../../shared/conversation-transcript-deliverable'
import { buildCompleteSessionTranscript } from '../../../transcripts/complete-session-transcript'
import { defineMethod } from '../core'
import { requireStructuredCapability } from './structured-agent-session-gate'

/** A separate method prevents an older host silently answering a full-history request with its tail. */
export const COMPLETE_TRANSCRIPT_METHOD = defineMethod({
  name: 'transcripts.buildCompleteDeliverable',
  params: z
    .object({
      kind: z.enum(['provider', 'structured']),
      agent: z.string().min(1),
      sessionId: z.string().min(1),
      transcriptPath: z.string().min(1).optional(),
      capturedAt: z.string().datetime(),
      expectedConnectionId: z.string().min(1).nullable()
    })
    .strict(),
  handler: async (params, context): Promise<TranscriptDeliverableRpcResult> => {
    if (params.kind === 'structured') {
      requireStructuredCapability(context)
    }
    const { signal } = context
    const result = await buildCompleteSessionTranscript(params, signal)
    if (result.kind === 'error') {
      return {
        error: result.code,
        ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes })
      }
    }
    if (result.kind === 'refused') {
      return { reason: TRANSCRIPT_REFUSAL_REASON, redactions: result.redactions }
    }
    return {
      name: result.deliverable.name,
      contentBase64: result.deliverable.bytes.toString('base64'),
      sha256: result.deliverable.sha256,
      size: result.deliverable.size,
      messageCount: result.deliverable.messageCount,
      truncatedBlocks: result.deliverable.truncatedBlocks,
      earlierMessagesOmitted: result.earlierMessagesOmitted,
      omittedRecords: result.omittedRecords
    }
  }
})
