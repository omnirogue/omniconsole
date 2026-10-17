import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { DispatchRoutingMode } from '../../shared/dispatch-routing-mode'
import type { SessionPrepRouterCatalog } from './session-prep-router-types'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type {
  SessionBatchFolderOrigin,
  SessionBatchSessionOrigin
} from '../../shared/session-batch-origin'
import type { PrepRepoChoice } from '../../shared/session-prep-types'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SessionPrepLaunchedSurface } from './session-prep-folders'
import type { SessionPrepRouterResult, SessionPrepRouterRequest } from './session-prep-router-cli'

export type SessionPrepWorkspace = {
  path: string
  repoId: string
  isFolder: boolean
  isRemote: boolean
  connectionId?: string
  hostId?: string
  hostAliases?: string[]
  connectionGeneration?: number
  connectionBinding?: string
}

export type SessionPrepRepo = PrepRepoChoice & {
  id: string
  /** Canonical git identity groups registered copies on different hosts. */
  repositoryKey?: string
  path: string
  isFolder: boolean
  isRemote: boolean
  connectionId?: string
  hostId?: string
  hostAliases?: string[]
  connectionGeneration?: number
  connectionBinding?: string
}

export type SessionPrepHost = {
  resolveWorktree(worktreeId: string): Promise<SessionPrepWorkspace>
  /** Where a terminal request starts when its own workspace does not resolve; null when none. */
  defaultSourceWorktreeId?(): string | null
  listRepos(): SessionPrepRepo[]
  resolveRepo(selector: string): SessionPrepRepo | null
  createWorktreeWithAgent(args: {
    connectorLaunch?: SessionPrepConnectorLaunch
    batchId?: string
    repoId: string
    expectedWorkspace?: SessionPrepWorkspace
    name: string
    agent: TuiAgent
    prompt: string
    /** Model and effort for the startup agent; absent keeps the agent's defaults. */
    launch?: AgentLaunchPreferences
    /** A live automatic choice that must be verified on the account actually launched. */
    routedModel?: string
  }): Promise<{ worktreeId: string; paneHandle?: string; surface?: SessionPrepLaunchedSurface }>
  resolveTerminalPaneKey?(handle: string): Promise<string | null>
  createAgentSessionIn(args: {
    connectorLaunch?: SessionPrepConnectorLaunch
    batchId?: string
    worktreeId: string
    expectedWorkspace?: SessionPrepWorkspace
    agent: TuiAgent
    prompt: string
    clientOperationId: string
    launch?: AgentLaunchPreferences
    /** A live automatic choice that must be verified on the account actually launched. */
    routedModel?: string
  }): Promise<SessionPrepLaunchedSurface | void>
  /**
   * Files a launched session in a sidebar folder: a path, created when missing, or a folder that
   * already exists (never recreated). `origin` records which batch item it came from.
   */
  fileSession(args: {
    folder: string | { id: string; path: string }
    surface: SessionPrepLaunchedSurface
    origin?: SessionBatchSessionOrigin
    /** The person's words that asked for the launch; recorded as filing's reason. */
    request?: string
  }): Promise<{
    path: string
  }>
  /** Resolves a captured folder ID without creating or substituting a same-named folder. */
  resolveExistingFolder?(id: string): Promise<{ id: string; path: string }>
  /** A new top-level Active folder for one batch; `name(n)` is its n-th look-alike-free choice. */
  createBatchFolder(args: {
    name: (attempt: number) => string
    origin: Omit<SessionBatchFolderOrigin, 'folderId'>
  }): Promise<{ id: string; path: string }>
  worktreeExistsByName(repoId: string, name: string): Promise<boolean>
  findWorktreeIdByName(repoId: string, name: string): Promise<string | null>
  isAgentEnabled(agent: TuiAgent): boolean
  /** The dispatch router's pick for an unnamed model or effort; null or absent keeps today's choice. */
  discoverRouteModels?(request: SessionPrepRouterRequest): Promise<SessionPrepRouterCatalog>
  routingMode?(requested?: DispatchRoutingMode): DispatchRoutingMode
  routeDispatch?(request: SessionPrepRouterRequest): Promise<SessionPrepRouterResult | null>
  /**
   * Binds a launched session's Done When lines to a verify gate that runs when it finishes;
   * absent, prepared sessions carry their lines only in the brief.
   */
  attachVerify?(args: {
    worktreeId: string
    paneKey: string
    title: string
    doneWhen: readonly string[]
    agent: TuiAgent
  }): Promise<{ attached: true } | { attached: false; reason: string; retryable?: boolean }>
  /** What a session filed in `folder` inherits from its project on `host` (plan §8); absent, nothing. */
  projectLaunch?(args: {
    folder: string
    host: string
    worktreeId?: string
    templateId?: string
  }): Promise<SessionProjectLaunch | null>
}
