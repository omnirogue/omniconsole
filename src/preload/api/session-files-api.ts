import type {
  SessionPullRequestFacts,
  SessionPullRequestRef
} from '../../shared/session-pull-request-facts'

/** Read-only previews for the Files & links list; the main process validates every argument. */
export type SessionFilesApi = {
  /** Local incremental session index; null means unavailable or not indexed. */
  indexedPullRequests?: (args: {
    agent: string
    sessionId: string
  }) => Promise<SessionPullRequestRef[] | null>
  /** TCP-connect probe of a loopback URL's port; rejects any non-loopback URL. */
  probeLoopback: (url: string) => Promise<'live' | 'stopped' | 'unverifiable'>
  /** First-frame thumbnail data URL for an authorized local video, or null. */
  videoThumbnail: (args: { filePath: string }) => Promise<string | null>
  /** A session PR's state, approval, checks and deploy from `gh`; null when GitHub cannot say. */
  pullRequestFacts?: (ref: SessionPullRequestRef) => Promise<SessionPullRequestFacts | null>
}
