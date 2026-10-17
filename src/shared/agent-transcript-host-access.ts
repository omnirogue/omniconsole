import type { SshOmpChatRequest, SshOmpChatResult } from './ssh-native-chat'
import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from './native-chat-transcript-page'

export type AgentTranscriptHostAccess = {
  readOmpTail?: (args: SshOmpChatRequest, signal?: AbortSignal) => Promise<SshOmpChatResult>
  resolveSource: (agent: string, sessionId: string, signal?: AbortSignal) => Promise<string | null>
  readOpenCodePage: (
    args: NativeChatTranscriptPageArgs,
    signal?: AbortSignal
  ) => Promise<NativeChatTranscriptPageResult>
}
