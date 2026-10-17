import type { IssueInfo, PRInfo } from '../../shared/github/pull-request-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'

export type WorkspaceSessionApi = {
  session: {
    // hostId defaults to the 'local' partition on main, so omitting it stays backward-compatible.
    get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
    set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
    patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
    flush: () => Promise<void>
    /** Drop a deleted tab's saved row from main-owned terminal membership; true if removed.
     *  Optional: the web runtime and older preloads have no main-owned membership to retire. */
    retireDeletedTerminalTab?: (tabId: string) => Promise<boolean>
    readTerminalScrollback: (args: { ref: string }) => string | null
    setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
  }
  cache: {
    getGitHub: () => Promise<{
      pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
      issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
    }>
    setGitHub: (args: {
      cache: {
        pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
        issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
      }
    }) => Promise<void>
  }
  remoteWorkspace: {
    get: (args: { targetId: string }) => Promise<RemoteWorkspaceSnapshot | null>
    setForConnectedTargets: (args: {
      session?: WorkspaceSessionState
      hydratedTargetIds?: string[]
    }) => Promise<{ targetId: string; result: RemoteWorkspacePatchResult }[]>
    listEnabledConnectedTargets: () => Promise<string[]>
    listConnectedClients: (args?: {
      targetIds?: string[]
    }) => Promise<{ targetId: string; clients: RemoteWorkspaceConnectedClient[] }[]>
    clientId: () => Promise<string>
    onChanged: (callback: (event: RemoteWorkspaceChangedEvent) => void) => () => void
  }
}
