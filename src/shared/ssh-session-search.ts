import { z } from 'zod'
import type { SessionSearchHit } from './session-search-types'
import { SESSION_SEARCH_MAX_LIMIT, SESSION_SEARCH_QUERY_MAX_CHARS } from './session-search-types'

export const SSH_SESSION_SEARCH_METHOD = 'sessionSearch.query'
export const sshSessionSearchParams = z.object({
  query: z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS),
  limit: z.number().int().min(1).max(SESSION_SEARCH_MAX_LIMIT)
})
export type SshSessionSearchParams = z.infer<typeof sshSessionSearchParams>
export type SshSessionSearchResult =
  | { supported: false; message: string }
  | {
      supported: true
      hits: SessionSearchHit[]
      indexedSessions: number
      pendingFiles: number
      passes: number
      lastPassAt: number | null
      modelLoaded: boolean
    }
