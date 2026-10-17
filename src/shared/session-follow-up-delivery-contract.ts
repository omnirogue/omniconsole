import type {
  ExactHandoffFile,
  HandoffDetail,
  HandoffRespond,
  HandoffReturn,
  HandoffSend,
  HandoffSendCardless,
  HandoffThreadUpload
} from './console-handoff-contract'
import type {
  SessionFollowUpExceptionCode,
  SessionFollowUpFilePin,
  SessionFollowUpRule
} from './session-follow-up-rule'
import type {
  ChatAgentSend,
  ChatAgentReceipt,
  ChatAgentRecipient
} from './console-chat-agent-contract'

/** What a saved follow-up's delivery reads and calls, and how it fails; no UI, no store. */
export class FollowUpException extends Error {
  constructor(
    readonly code: SessionFollowUpExceptionCode,
    readonly subject: string,
    readonly detail = ''
  ) {
    super(detail || `${code}: ${subject}`)
    this.name = 'FollowUpException'
  }
}

export type FollowUpHostIo = {
  /** False when the path is absent; throws when its computer cannot answer. */
  exists: (path: string) => Promise<boolean>
  size: (path: string) => Promise<number>
  readExact: (path: string) => Promise<ExactHandoffFile>
}

export type FollowUpHubIo = {
  get?: (input: { threadId: string }) => Promise<HandoffDetail>
  respond?: (input: HandoffRespond) => Promise<{ thread_id?: string }>
  returnFile?: (input: HandoffReturn) => Promise<{ thread_id?: string }>
  agentRecipients?: () => Promise<{ agents: ChatAgentRecipient[] }>
  sendAgent?: (input: ChatAgentSend) => Promise<ChatAgentReceipt>
  upload: (taskId: string, file: ExactHandoffFile) => Promise<{ path: string; sha256: string }>
  send: (input: HandoffSend) => Promise<{ thread_id?: string }>
  /** A request with no card: the files travel as exact attachments (card-less handoffs on). */
  sendCardless: (input: HandoffSendCardless) => Promise<{ thread_id?: string }>
  /** A file added to the thread after it exists, for attachments the create could not carry. */
  uploadThreadFile: (input: HandoffThreadUpload) => Promise<{ thread_id?: string }>
  isRejected: (error: unknown) => boolean
}

export type FollowUpDeliveryContext = {
  /** The rule as saved now; null once it was cancelled, edited or removed. */
  current: () => SessionFollowUpRule | null
  save: (rule: SessionFollowUpRule) => Promise<void>
  hub: FollowUpHubIo
  /** Exact bytes for a pin: captured in this run, or re-read after a restart. */
  bytes: (pin: SessionFollowUpFilePin) => Promise<ExactHandoffFile>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
