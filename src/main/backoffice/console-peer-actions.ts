import {
  communicationMode,
  peerJoinReceipt,
  peerJoinRequest,
  peerPostReceipt,
  peerPostRequest,
  peerReplyReceipt,
  peerReplyRequest,
  type PeerActionApi
} from '../../shared/peer-action-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

export const consolePeerActions: PeerActionApi = {
  readCommunicationMode: () => request('/api/communication/config', 'GET', communicationMode),
  postDiscussion: (args) =>
    validated(args, peerPostRequest, (input) =>
      request(
        `/api/peer/rooms/${input.roomId}/messages`,
        'POST',
        peerPostReceipt.refine((value) => value.post.room_id === input.roomId),
        { text: input.text, references: input.references, idempotency_key: input.operationId }
      )
    ),
  joinDiscussion: (args) =>
    validated(args, peerJoinRequest, (input) =>
      request(
        `/api/peer/rooms/${input.roomId}/join`,
        'POST',
        peerJoinReceipt.refine(
          (value) => value.room_id === input.roomId && value.membership.room_id === input.roomId
        ),
        { idempotency_key: input.operationId }
      )
    ),
  replyPeerMessage: (args) =>
    validated(args, peerReplyRequest, (input) =>
      request(
        '/api/peer/reply',
        'POST',
        peerReplyReceipt.refine((value) => value.reply_to === input.messageId),
        {
          message_id: input.messageId,
          text: input.text,
          references: input.references,
          idempotency_key: input.operationId
        }
      )
    )
}
