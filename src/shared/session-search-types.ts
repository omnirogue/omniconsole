// Content search over agent transcripts: the wire shape shared by the index service, the
// runtime RPC, the CLI and the renderer. Every field is optional-tolerant on read because
// paired runtimes update independently of the client that queries them.

export type SessionSearchAgent = 'claude' | 'codex'

export type SessionSearchRole = 'user' | 'assistant' | 'tool'

/** Snippet text carries the matched span between these two markers. */
export const SESSION_SEARCH_MARK_OPEN = '\u0002'
export const SESSION_SEARCH_MARK_CLOSE = '\u0003'

export type SessionSearchSnippet = {
  role: SessionSearchRole
  text: string
}

export type SessionSearchSummarySource = 'model' | 'extractive'

/**
 * What found the session: its title, what was said in it (or its summary), or only a summary
 * about a similar topic. Absent from older hosts.
 */
export type SessionSearchMatch = 'title' | 'text' | 'meaning'

/** A search hit's row in the calling controller's sidebar, joined by the local CLI. */
export type SessionSearchHitRow = {
  paneKey: string | null
  tabId: string | null
  title: string
  state: string
  verdict: string
  archived: boolean
  /** `manual` or `automatic`; null when not archived, absent when the controller cannot tell. */
  archiveKind?: 'manual' | 'automatic' | null
  folder: string | null
}

export type SessionSearchHit = {
  /** `${agent}:${sessionId}`; unique per host. */
  sessionKey: string
  /** `<agent>:<sessionId>@<host>` for `--ref`; added by the local CLI, absent from older hosts. */
  ref?: string
  sessionId: string
  agent: SessionSearchAgent
  /** Machine the transcript lives on, as people name it ("mac-studio", "mw0002"). */
  hostLabel: string
  /** Execution host the hit came from: 'local' or `runtime:<environmentId>`. */
  executionHostId: string
  title: string
  cwd: string | null
  transcriptPath: string
  /**
   * Every sidebar row holding this conversation (the local CLI's join); `[]` means none: its tab
   * was closed. Absent when the join could not run (see `sidebarJoin`).
   */
  sidebar?: SessionSearchHitRow[]
  lastActivityAt: number | null
  score: number
  match?: SessionSearchMatch
  /** Plain-language reasons, strongest first ("“Uma” said 61 times", "summary mentions …"). */
  reasons: string[]
  snippets: SessionSearchSnippet[]
  summary: string | null
  summarySource: SessionSearchSummarySource | null
  /** The live local sidebar row this transcript belongs to, when a caller joined one. */
  paneKey?: string
  tabId?: string | null
}

export type SessionSearchHostState =
  | 'searched'
  | 'indexing'
  | 'unreachable'
  | 'unsupported'
  | 'failed'

export type SessionSearchHostStatus = {
  hostLabel: string
  executionHostId: string
  state: SessionSearchHostState
  /** Paired controller that owns this SSH coverage; never a local target selector. */
  ownerEnvironmentId?: string
  coverage?: 'owned-ssh'
  indexedSessions?: number
  pendingFiles?: number
  message?: string
}

export type SessionSearchArgs = {
  query: string
  limit?: number
  /** Also ask paired runtimes and report SSH coverage gaps; default for desktop and CLI. */
  includeRemote?: boolean
  /** Report this controller’s registered SSH targets without paired fan-out. */
  includeOwnedSsh?: boolean
}

export type SessionSearchResult = {
  query: string
  hits: SessionSearchHit[]
  hosts: SessionSearchHostStatus[]
  tookMs: number
  /** Confirms that owned SSH coverage was requested and included, even if empty. */
  ownedSshCoverage?: true
  /** Whether hits were joined to this controller's sidebar rows; `unavailable` says why not. */
  sidebarJoin?: { state: 'joined' } | { state: 'unavailable'; reason: string }
}

export type SessionSearchSummaryArgs = {
  sessionKey: string
}

export const SESSION_SEARCH_QUERY_MAX_CHARS = 512
export const SESSION_SEARCH_DEFAULT_LIMIT = 20
export const SESSION_SEARCH_MAX_LIMIT = 100
