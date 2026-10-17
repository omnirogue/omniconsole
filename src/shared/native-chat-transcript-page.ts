import type { AgentType, NativeChatMessage } from './native-chat-types'

export type NativeChatTranscriptCursor = {
  filePath: string
  originPath?: string
  byteOffset: number
  snapshotSize: number
  fileIdentity: string
  sourceEpoch: string
  observedSize: number
  observedMtime: number | null
  connectionId: string | null
  agent: AgentType
  sessionId: string
  droppingOversizedRecord?: boolean
}

export type NativeChatTranscriptPageArgs = {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  connectionId?: string
  cursor?: NativeChatTranscriptCursor
  limit?: number
}

export type NativeChatTranscriptPageResult = {
  source: { connectionId: string | null }
  warnings?: string[]
} & (
  | {
      messages: NativeChatMessage[]
      /** JSONL records join with LF; JSON fragments join without separators and require final document validation. */
      sourceRecords: { byteOffset: number; text: string }[]
      coverage: {
        format: 'jsonl' | 'json'
        projection: 'display' | 'raw-only'
        fromByteOffset: number
        toByteOffset: number
        snapshotBytes: number
        rawRecords: 'complete' | 'partial'
      }
      cursor?: NativeChatTranscriptCursor
      complete: boolean
      malformedRecordCount: number
      oversizedRecordCount: number
      truncatedRecordCount: number
    }
  | { error: string; notFound?: true }
)
