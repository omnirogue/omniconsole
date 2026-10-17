import { z } from 'zod'
import type { RelayDispatcher } from './dispatcher'
import { readOpenCodeTranscriptPage } from '../main/native-chat/opencode-transcript-page'

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const paramsSchema = z
  .object({
    agent: z.literal('opencode'),
    sessionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(512),
    transcriptPath: z.string().min(1).max(32768).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z
      .object({
        filePath: z.string().min(1).max(32768),
        byteOffset: offset,
        snapshotSize: offset,
        fileIdentity: z.string().min(1),
        sourceEpoch: z.string().min(1),
        observedSize: offset,
        observedMtime: z.number().finite().nullable(),
        connectionId: z.null(),
        agent: z.literal('opencode'),
        sessionId: z.string().min(1),
        droppingOversizedRecord: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()

export function registerOpenCodeTranscriptHandler(dispatcher: RelayDispatcher): void {
  dispatcher.onRequest('transcript.readOpenCodePage', async (params, context) => {
    const args = paramsSchema.parse(params)
    if (context?.isStale()) {
      throw new Error('The OpenCode transcript connection changed. Retry capture.')
    }
    // A response shares the relay's 1 MiB control queue with concurrent requests.
    const page = await readOpenCodeTranscriptPage(args, context?.signal, {
      maxPayloadBytes: 256 * 1024
    })
    if (context?.isStale()) {
      throw new Error('The OpenCode transcript connection changed. Retry capture.')
    }
    return page
  })
}
