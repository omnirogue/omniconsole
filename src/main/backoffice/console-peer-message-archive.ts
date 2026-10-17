import {
  peerMessageArchiveRequest,
  peerMessageArchiveReceipt
} from '../../shared/peer-message-contract'
import { chatAgentMessageDetail } from '../../shared/console-chat-agent-contract'
import type { ConsoleHandoffApi } from '../../shared/console-handoff-contract'
import { withHandoffViewer } from './console-handoff-archive'
import { failure, validated } from './console-workflow-transport'

const ROOT = '/api/gtd/hub/api/session-peers/messages'

export const archivePeerMessage: ConsoleHandoffApi['archiveMessage'] = (args) =>
  validated(args, peerMessageArchiveRequest, (input) =>
    withHandoffViewer(async (employeeId, request) => {
      const detail = await request(
        `${ROOT}/${input.messageId}`,
        'GET',
        chatAgentMessageDetail.refine(({ thread }) => thread.id === input.messageId)
      )
      if (!detail.ok) {
        return detail
      }
      const thread = detail.data.thread
      if (![thread.sender_employee_id, thread.recipient_employee_id].includes(employeeId)) {
        return failure('forbidden', 'Only your own sent or received messages can be deleted.', 403)
      }
      return request(
        `${ROOT}/${input.messageId}/archive`,
        'POST',
        peerMessageArchiveReceipt.refine(
          (receipt) => receipt.message_id === input.messageId && receipt.employee_id === employeeId
        ),
        { archived: input.archived, operation_id: input.operationId }
      )
    })
  )
