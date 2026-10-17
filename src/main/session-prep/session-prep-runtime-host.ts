import {
  prepareSessionPrepLaunchEnvironment,
  type SessionPrepRoutedLaunch
} from './session-prep-routed-launch'
import {
  createSessionPrepConnectorWorktree,
  sessionPrepConnectorRequest,
  sessionPrepLaunchSurface
} from './session-prep-connector-runtime'
import type { DispatchRoutingMode } from '../../shared/dispatch-routing-mode'
import {
  createSessionPrepModelCatalog,
  type SessionPrepModelDiscovery
} from './session-prep-model-catalog'
import { attemptLaunchProvenance } from '../launch-ledger/launch-provenance-guard'
import type { LaunchCause } from '../../shared/launch-cause'
import type {
  AgentLaunchPreferences,
  RuntimeCreateAgentSessionRequest
} from '../../shared/agent-session-host-authority'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-worktree-contracts'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'
import { splitWorktreeId } from '../../shared/worktree/id'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  createSessionPrepBatchFolder,
  ensureSessionPrepFolder,
  moveSessionPrepSession,
  recordedSessionPrepRequest,
  resolveExistingSessionPrepFolder,
  recordSessionPrepSessionOrigin,
  type SessionPrepFilingRecorder,
  type SessionPrepFolderRequest,
  type SessionPrepLaunchedSurface
} from './session-prep-folders'
import type { SessionPrepHost, SessionPrepRepo } from './session-prep-host'
import { prepareSessionPrepRemoteAccount } from './session-prep-remote-account'
import { runSessionPrepRouter } from './session-prep-router-cli'
import { sessionPrepSshBinding } from './session-prep-ssh-binding'
import { resolveSessionPrepTerminalPaneKey } from './session-prep-terminal-identity'
import {
  folderWorkspace,
  repoWorkspace,
  toPrepRepo,
  findWorktreeIdByName,
  sessionPrepFolderById
} from './session-prep-runtime-workspaces'
import {
  assertSessionPrepExecutionHost,
  assertSessionPrepWorkspaceUnchanged,
  SessionPrepHostError
} from './session-prep-execution-host'

export type SessionPrepRuntime = {
  getStatus?(): { runtimeId: string }
  prepareSessionPrepRoutedLaunch?(input: SessionPrepRoutedLaunch): Promise<Record<string, string>>
  getDispatchRoutingMode?(requested?: DispatchRoutingMode): DispatchRoutingMode
  discoverRuntimeCommitMessageModels?: SessionPrepModelDiscovery
  listRepos(): Repo[]
  listFolderWorkspaces(): FolderWorkspace[]
  listManagedWorktrees(repoSelector?: string, limit?: number): Promise<RuntimeWorktreeListResult>
  createManagedWorktree(args: {
    repoSelector: string
    name: string
    startupAgent?: TuiAgent
    startupPrompt?: string
    startupLaunchCause?: LaunchCause
    startupLaunchPreferences?: AgentLaunchPreferences
    startupLaunchEnv?: Record<string, string>
    activate: false
  }): Promise<{
    worktree: { id: string }
    startupTerminal?: { spawned: boolean; handle?: string; tabId?: string; paneKey?: string | null }
  }>
  createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller?: {
      clientKind?: 'mobile' | 'runtime'
      preparedLaunchEnv?: Record<string, string>
      launchCause?: LaunchCause
    }
  ): Promise<{
    terminal?: SessionPrepLaunchedSurface & { handle?: string }
    [key: string]: unknown
  }>
  /** Lists or changes the Conversations sidebar folders through the window that owns them. */
  requestSessionFolders(request: SessionFolderRelayRequest): Promise<unknown>
  getTerminalPaneKey?(handle: string): string | null
}

export function createSessionPrepRuntimeHost(
  runtime: SessionPrepRuntime,
  disabledTuiAgents: () => Iterable<unknown> | null | undefined,
  sshTargets: () => SshTarget[] = () => [],
  /** Records filing as launch changes; absent, filing is relayed unrecorded (tests). */
  filingRecorder?: SessionPrepFilingRecorder
): SessionPrepHost {
  // Why one at a time: sibling items naming the same new folder must not each create it.
  let folderLock: Promise<unknown> = Promise.resolve()
  const request = (folderRequest: SessionFolderRelayRequest) =>
    runtime.requestSessionFolders(folderRequest)
  // Why: every folder change filing makes is recorded as launch filing with the request's words.
  const filingFor = (launchRequest?: string): SessionPrepFolderRequest =>
    filingRecorder ? recordedSessionPrepRequest(request, filingRecorder, launchRequest) : request
  const resolveNamed = (path: string, via: SessionPrepFolderRequest) => {
    const resolving = folderLock.then(() => ensureSessionPrepFolder(via, path))
    folderLock = resolving.catch(() => undefined)
    return resolving
  }
  const connectionBinding = (connectionId?: string | null) => {
    if (!connectionId) {
      return {}
    }
    return sessionPrepSshBinding(connectionId, sshTargets())
  }
  const describeRepo = (repo: Repo): SessionPrepRepo => {
    const target = sshTargets().find((entry) => entry.id === repo.connectionId)
    return {
      ...toPrepRepo(repo),
      ...(target ? connectionBinding(target.id) : {}),
      host:
        target?.label ??
        repo.executionHostId ??
        (repo.connectionId ? `ssh:${repo.connectionId}` : 'local'),
      hostId: repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local'),
      hostAliases: target
        ? [target.id, `ssh:${target.id}`, target.label, target.configHost, target.host].filter(
            (value): value is string => Boolean(value)
          )
        : [repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')]
    }
  }
  const host: SessionPrepHost = {
    async resolveWorktree(worktreeId) {
      const folder = sessionPrepFolderById(runtime.listFolderWorkspaces(), worktreeId)
      if (folder) {
        return {
          ...folderWorkspace(folder),
          ...connectionBinding(folder.connectionId)
        }
      }
      const parsed = splitWorktreeId(worktreeId)
      const repo = parsed ? runtime.listRepos().find((entry) => entry.id === parsed.repoId) : null
      if (parsed && repo) {
        return {
          ...repoWorkspace(repo, parsed.worktreePath),
          ...connectionBinding(repo.connectionId)
        }
      }
      throw new Error('That workspace is not available for session prep.')
    },
    listRepos() {
      return runtime.listRepos().map(describeRepo)
    },
    resolveRepo(selector) {
      return (
        runtime
          .listRepos()
          .map(describeRepo)
          .find((repo) => repo.selector === selector) ?? null
      )
    },
    async createWorktreeWithAgent(args) {
      const repo = runtime.listRepos().find((entry) => entry.id === args.repoId)
      if (!repo) {
        throw new Error('The launch repository is no longer registered.')
      }
      const workspace = {
        ...repoWorkspace(repo, repo.path),
        ...connectionBinding(repo.connectionId)
      }
      assertSessionPrepExecutionHost(workspace)
      // Preparation may have used a child worktree, while the new worktree starts from its repo.
      assertSessionPrepWorkspaceUnchanged(
        args.expectedWorkspace && { ...args.expectedWorkspace, path: workspace.path },
        workspace
      )
      if (args.connectorLaunch) {
        return createSessionPrepConnectorWorktree(runtime, host, args)
      }
      const selectedEnv = repo.connectionId
        ? await prepareSessionPrepRemoteAccount(repo.connectionId, args.agent, args.launch?.model)
        : undefined
      const env = await prepareSessionPrepLaunchEnvironment(runtime, workspace, args, selectedEnv)
      const current = runtime.listRepos().find((entry) => entry.id === args.repoId)
      if (!current) {
        throw new SessionPrepHostError('The launch repository is no longer registered.')
      }
      assertSessionPrepWorkspaceUnchanged(workspace, {
        ...repoWorkspace(current, current.path),
        ...connectionBinding(current.connectionId)
      })
      const created = await runtime.createManagedWorktree({
        repoSelector: `id:${args.repoId}`,
        name: args.name,
        startupAgent: args.agent,
        startupPrompt: args.prompt,
        startupLaunchCause: attemptLaunchProvenance<LaunchCause>(
          'session-prep',
          () => ({
            trigger: 'session-prep',
            actor: { kind: 'app' },
            ...(args.batchId ? { reference: { sessionPrepBatchId: args.batchId } } : {})
          }),
          { trigger: 'unknown' }
        ),
        ...(env ? { startupLaunchEnv: env } : {}),
        ...(args.launch ? { startupLaunchPreferences: args.launch } : {}),
        activate: false
      })
      const terminal = created.startupTerminal
      if (!terminal?.spawned) {
        throw new SessionPrepHostError(
          'The workspace was created, but agent startup is unverified. Inspect it before launching another session.'
        )
      }
      return {
        worktreeId: created.worktree.id,
        ...(terminal.handle ? { paneHandle: terminal.handle } : {}),
        ...(terminal ? { surface: { tabId: terminal.tabId, paneKey: terminal.paneKey } } : {})
      }
    },
    resolveTerminalPaneKey: (handle) => resolveSessionPrepTerminalPaneKey(runtime, handle),
    async createAgentSessionIn(args) {
      const workspace = await host.resolveWorktree(args.worktreeId)
      assertSessionPrepExecutionHost(workspace)
      assertSessionPrepWorkspaceUnchanged(args.expectedWorkspace, workspace)
      const selectedEnv = workspace.connectionId
        ? await prepareSessionPrepRemoteAccount(
            workspace.connectionId,
            args.agent,
            args.launch?.model
          )
        : undefined
      const env = await prepareSessionPrepLaunchEnvironment(runtime, workspace, args, selectedEnv)
      assertSessionPrepWorkspaceUnchanged(workspace, await host.resolveWorktree(args.worktreeId))
      // Why: the runtime resolves folders only by their `folder:<id>` key.
      const folder = sessionPrepFolderById(runtime.listFolderWorkspaces(), args.worktreeId)
      const created = await runtime.createAgentSession(
        {
          clientOperationId: args.clientOperationId,
          ...sessionPrepConnectorRequest(runtime, args.connectorLaunch, args.agent),
          worktree: `id:${folder ? folderWorkspaceKey(folder.id) : args.worktreeId}`,
          agent: args.agent,
          prompt: args.prompt,
          promptDelivery: 'auto-submit',
          presentation: 'background',
          ...(args.launch ? { launchPreferences: args.launch } : {})
        },
        {
          clientKind: 'runtime',
          launchCause: {
            trigger: 'session-prep',
            ...(args.batchId ? { reference: { sessionPrepBatchId: args.batchId } } : {}),
            requestId: args.clientOperationId
          },
          ...(env ? { preparedLaunchEnv: env } : {})
        }
      )
      return sessionPrepLaunchSurface(created, args.connectorLaunch, args.agent)
    },
    async fileSession(args) {
      const filing = filingFor(args.request)
      const folder =
        typeof args.folder === 'string' ? await resolveNamed(args.folder, filing) : args.folder
      const sessionKey = await moveSessionPrepSession(filing, args.surface, folder)
      if (args.origin) {
        await recordSessionPrepSessionOrigin(request, sessionKey, args.origin)
      }
      return { path: folder.path }
    },
    resolveExistingFolder: (id) => resolveExistingSessionPrepFolder(request, id),
    async createBatchFolder(args) {
      const filing = filingFor(args.origin.requestExcerpt)
      const creating = folderLock.then(() => createSessionPrepBatchFolder(filing, args))
      folderLock = creating.catch(() => undefined)
      return creating
    },
    async worktreeExistsByName(repoId, name) {
      return (await findWorktreeIdByName(runtime, repoId, name)) !== null
    },
    async findWorktreeIdByName(repoId, name) {
      return findWorktreeIdByName(runtime, repoId, name)
    },
    isAgentEnabled(agent) {
      return isTuiAgentEnabled(agent, disabledTuiAgents())
    },
    ...(runtime.discoverRuntimeCommitMessageModels
      ? {
          discoverRouteModels: createSessionPrepModelCatalog(
            runtime.discoverRuntimeCommitMessageModels.bind(runtime)
          )
        }
      : {}),
    routingMode: (requested) => runtime.getDispatchRoutingMode?.(requested) ?? requested ?? 'live',
    routeDispatch: (request) =>
      runSessionPrepRouter({
        ...request,
        mode: runtime.getDispatchRoutingMode?.(request.mode) ?? request.mode
      })
  }
  return host
}
