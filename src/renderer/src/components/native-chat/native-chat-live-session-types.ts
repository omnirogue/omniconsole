import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` key — selects the live hook entry. */
  paneKey: string
  agent: AgentType
  /** The agent's own session id, or null before it reports one — nothing to read/tail, so the view shows live hook state. */
  sessionId: string | null
  /** Authoritative transcript path from the hook, preferred over reconstructing it from sessionId. Null when not reported. */
  transcriptPath?: string | null
  /** Runtime owner (Model B): non-null routes read/subscribe to the remote host; null keeps the local IPC path. */
  runtimeEnvironmentId?: string | null
  sshConnectionId?: string | null
  terminalTabId?: string
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** Latest provider turn boundary, used to settle orphaned running tool rows. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the read window to page in older history (scrolled-to-top trigger). */
  loadEarlier: () => void
  /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
   *  outranks (and so hides) 'loading', which would let a consumer deciding from
   *  an empty list treat an in-flight transcript as real history. */
  readPhase: ReadState['phase']
  readError?: string
  /** Absent on static evidence previews that share the message-list shape. */
  retry?: () => void
}

export type ReadState =
  | { phase: 'loading' }
  /** The host reported no transcript behind this window yet: rendered, but not a
   *  settled read, so nothing may treat the empty list as real history. */
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** True while no transcript read has settled — 'loading' and 'awaiting' alike.
 *  Consumers that must not act on `messages` as real history use this, not a
 *  bare `!== 'ready'`, which would also swallow the error surface. */
export function isNativeChatTranscriptUnsettled(phase: ReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}
