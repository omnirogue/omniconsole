import { z } from 'zod'
import type { NativeChatTranscriptPageArgs } from '../../../../shared/native-chat-transcript-page'
import {
  readNativeChatTranscriptPage,
  MAX_TRANSCRIPT_PAGE_RECORDS
} from '../../../native-chat/transcript-page-reader'
import { defineMethod } from '../core'

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

// A distinct method makes old hosts refuse source-host routing instead of stripping it.
export const NATIVE_CHAT_TRANSCRIPT_PAGE_METHOD = defineMethod({
  name: 'nativeChat.readTranscriptPage',
  params: z.object({
    agent: z.string().min(1),
    sessionId: z.string().min(1),
    transcriptPath: z.string().min(1).optional(),
    connectionId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE_RECORDS).optional(),
    cursor: z
      .object({
        filePath: z.string().min(1),
        originPath: z.string().min(1).optional(),
        byteOffset: offset,
        snapshotSize: offset,
        fileIdentity: z.string().min(1),
        sourceEpoch: z.string().min(1),
        observedSize: offset,
        observedMtime: z.number().finite().nullable(),
        connectionId: z.string().min(1).nullable(),
        agent: z.string().min(1),
        sessionId: z.string().min(1),
        droppingOversizedRecord: z.boolean().optional()
      })
      .optional()
  }),
  handler: (params, { signal }) =>
    readNativeChatTranscriptPage(params as NativeChatTranscriptPageArgs, signal)
})
