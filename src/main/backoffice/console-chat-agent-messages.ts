import { z } from 'zod'
import {
  chatAgentFile,
  chatAgentMessageDetail,
  chatAgentMessageRequest
} from '../../shared/console-chat-agent-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'
import { downloadVerifiedConsoleFile } from './console-file-download'
import { archivePeerMessage } from './console-peer-message-archive'

const ROOT = '/api/gtd/hub/api/session-peers/messages'

export const chatAgentMessageClient = {
  archiveMessage: archivePeerMessage,
  getAgentMessage: (args: unknown) =>
    validated(args, chatAgentMessageRequest, ({ messageId }) =>
      request(
        `${ROOT}/${messageId}`,
        'GET',
        chatAgentMessageDetail.refine(({ thread }) => thread.id === messageId)
      )
    ),
  readAgentMessage: (args: unknown) =>
    validated(args, chatAgentMessageRequest, ({ messageId }) =>
      request(
        `${ROOT}/${messageId}/read`,
        'POST',
        chatAgentMessageDetail.refine(({ thread }) => thread.id === messageId),
        {}
      )
    ),
  resolveAgentMessage: (args: unknown) =>
    validated(args, chatAgentMessageRequest, ({ messageId }) =>
      request(
        `${ROOT}/${messageId}/resolve`,
        'POST',
        z.object({
          message: z.object({
            id: z.literal(messageId),
            state: z.literal('resolved')
          })
        }),
        {}
      )
    ),
  agentMessageFiles: (args: unknown) =>
    validated(args, chatAgentMessageRequest, ({ messageId }) =>
      request(
        `${ROOT}/${messageId}/files`,
        'GET',
        z.object({ message_id: z.literal(messageId), files: z.array(chatAgentFile) })
      )
    ),
  downloadAgentFile: (args: unknown) =>
    validated(
      args,
      chatAgentMessageRequest.extend({ file: chatAgentFile }).strict(),
      ({ messageId, file }) =>
        downloadVerifiedConsoleFile(`${ROOT}/${messageId}/files/${file.id}`, {
          ...file,
          available: true
        })
    )
}
