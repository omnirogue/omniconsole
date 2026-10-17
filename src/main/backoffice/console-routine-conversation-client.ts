import {
  boardConversationRequest,
  boardConversationResponse,
  boardMessageRequest,
  boardMessageResponse,
  type ConsoleRoutineConversationApi
} from '../../shared/console-routine-conversation-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

export const consoleRoutineConversationClient: ConsoleRoutineConversationApi = {
  getConversation: (args) =>
    validated(args, boardConversationRequest, ({ taskId }) =>
      request(`/api/work/card/${taskId}/conversation`, 'GET', boardConversationResponse)
    ),
  postMessage: (args) =>
    validated(args, boardMessageRequest, ({ taskId, content }) =>
      request(`/api/board/${taskId}/message`, 'POST', boardMessageResponse, { content })
    )
}
