import type {
  SessionSearchAgent,
  SessionSearchHit,
  SessionSearchSummarySource
} from '../../shared/session-search-types'
import type { TranscriptOrigin } from './transcript-origin'

export const SESSION_SEARCH_SERVICE_PROTOCOL = 1

export type SessionSearchServiceInit = {
  type: 'init'
  protocol: number
  dbPath: string
  modelDir: string
  homeDir: string
  appDataDirs: string[]
  hostLabel: string
  dutyCycle: number
  passIntervalMs: number
}

export type SessionSearchSummaryCandidate = {
  sessionKey: string
  prompt: string
  basisBytes: number
}

/** One work session as the omnios Work feed reads it (work-feed/work-feed-posts). */
export type SessionSearchFeedRow = {
  sessionKey: string
  agent: SessionSearchAgent
  sessionId: string
  title: string | null
  cwd: string | null
  firstTs: number | null
  lastTs: number | null
  userTurns: number
  textBytes: number
  firstAsk: string | null
  lastAnswer: string | null
  links: string[]
  summary: string | null
  summarySource: SessionSearchSummarySource | null
  origin: TranscriptOrigin
}

export type SessionSearchServiceStatus = {
  indexedSessions: number
  pendingFiles: number
  passes: number
  lastPassAt: number | null
  modelLoaded: boolean
}

export type SessionSearchServiceOperation =
  | { op: 'sessionLinks'; sessionKey: string }
  | { op: 'search'; query: string; limit: number }
  | { op: 'status' }
  | {
      op: 'summaryCandidates'
      limit: number
      minBytes: number
      activeSinceMs: number
      idleBeforeMs?: number
    }
  | { op: 'saveModelSummary'; sessionKey: string; summary: string; basisBytes: number }
  | { op: 'feedRows'; sinceMs: number; limit: number }
  | { op: 'summaryTitles'; sessionKeys: string[] }

export type SessionSearchServiceRequest = SessionSearchServiceOperation & {
  type: 'request'
  id: number
}

export type SessionSearchServiceParentMessage =
  | SessionSearchServiceInit
  | SessionSearchServiceRequest
  | { type: 'shutdown' }

export type SessionSearchServiceChildMessage =
  | { type: 'ready'; protocol: number }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }

export type SessionSearchServiceSearchValue = {
  hits: SessionSearchHit[]
} & SessionSearchServiceStatus

export function isSessionSearchChildMessage(
  value: unknown
): value is SessionSearchServiceChildMessage {
  const record = value as { type?: unknown } | null
  return (
    !!record &&
    typeof record === 'object' &&
    (record.type === 'ready' || record.type === 'result' || record.type === 'error')
  )
}
