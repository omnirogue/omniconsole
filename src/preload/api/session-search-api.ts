import type { SessionSearchArgs, SessionSearchResult } from '../../shared/session-search-types'

export type SessionSearchApi = {
  /** Content search over conversation transcripts on this computer and paired hosts. */
  query: (args: SessionSearchArgs) => Promise<SessionSearchResult>
}
