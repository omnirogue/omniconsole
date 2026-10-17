import { z } from 'zod'
import { PEER_MESSAGE_ID, peerMessageState } from './peer-message-contract'
import { peerRoomPost } from './peer-room-contract'
import type { ConsoleWorkflowResult } from './console-workflow-types'

const id = z.string().regex(PEER_MESSAGE_ID)
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const text = z
  .string()
  .trim()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 2048)
const references = z
  .array(
    z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .max(512)
  )
  .max(4)
  .default([])
export const peerPostRequest = z.object({ roomId: id, text, references, operationId }).strict()
export const peerJoinRequest = z.object({ roomId: id, operationId }).strict()
export const peerReplyRequest = z.object({ messageId: id, text, references, operationId }).strict()
export const peerSendRequest = peerReplyRequest.omit({ messageId: true }).extend({
  to: z.string().regex(/^emp_[A-Za-z0-9_-]{1,128}$/),
  purpose: z.enum(['question', 'status', 'dependency'])
})
export const peerPostReceipt = z.object({ post: peerRoomPost })
export const peerJoinReceipt = z.object({
  room_id: id,
  membership: z.object({ id, room_id: id, employee_id: id, session_id: id })
})
export const peerReplyReceipt = z.object({ id, reply_to: id, state: peerMessageState })

export const communicationMode = z
  .object({
    mode: z.enum(['legacy', 'omniconsole', 'unconfigured']),
    ready: z.boolean(),
    legacyWritesFenced: z.boolean()
  })
  .refine((value) => value.legacyWritesFenced === (value.mode !== 'legacy'))

export type PeerActionApi = {
  readCommunicationMode(): Promise<ConsoleWorkflowResult<z.infer<typeof communicationMode>>>

  postDiscussion(
    request: z.input<typeof peerPostRequest>
  ): Promise<ConsoleWorkflowResult<z.infer<typeof peerPostReceipt>>>
  joinDiscussion(
    request: z.input<typeof peerJoinRequest>
  ): Promise<ConsoleWorkflowResult<z.infer<typeof peerJoinReceipt>>>
  replyPeerMessage(
    request: z.input<typeof peerReplyRequest>
  ): Promise<ConsoleWorkflowResult<z.infer<typeof peerReplyReceipt>>>
}
