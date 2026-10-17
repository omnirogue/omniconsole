import type {
  AgentLaunchHostId,
  AgentLaunchReadinessAccount,
  AgentLaunchReadinessParams,
  AgentLaunchReadinessResult
} from '../../shared/agent-launch-account'
import { getRepoKind } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { prepareSessionPrepRemoteAccountSelection } from '../session-prep/session-prep-remote-account'
import type { AgentLaunchLoadReport } from './agent-launch-load'
import {
  previewLocalLaunchAccount,
  type LaunchAccountCapacity
} from './agent-session-local-account'
import { sshLaunchAccountReceipt } from './agent-session-ssh-account'

/** The launch resolver's answer, structurally: this module never reaches into runtime internals. */
export type AgentLaunchReadinessTarget = {
  scope: {
    id: string
    path: string
    connectionId: string | null
    repo: Pick<Repo, 'kind'> | null
    folderWorkspace: unknown
  }
  managedWorktree: { displayName?: string | null } | null
}

export type AgentLaunchReadinessDeps = {
  runtimeId: string
  /** The same resolver createAgentSession uses, so git, folder: and path: selectors agree. */
  resolveWorkspace: (selector: string) => Promise<AgentLaunchReadinessTarget>
  /** Whether a local spawn of the workspace runs in WSL, as the launch itself checks. */
  runsInWsl: (scope: AgentLaunchReadinessTarget['scope']) => boolean
  capacity: LaunchAccountCapacity | null
  /** Placement's bounded load and machine id for the executing host; only asked with `load`. */
  readLoad: (hostId: AgentLaunchHostId) => Promise<AgentLaunchLoadReport>
}

async function previewSshLaunchAccount(
  hostId: `ssh:${string}`,
  connectionId: string,
  params: AgentLaunchReadinessParams
): Promise<AgentLaunchReadinessAccount> {
  try {
    // Why read-only: the relay probe reads usage and returns a choice; the env is discarded.
    const prepared = await prepareSessionPrepRemoteAccountSelection(
      connectionId,
      params.agent,
      params.model
    )
    return {
      verified: true,
      receipt: sshLaunchAccountReceipt({
        hostId,
        provider: params.agent,
        model: params.model,
        account: prepared.account,
        readingAgeMs: prepared.readingAgeMs
      })
    }
  } catch (error) {
    return {
      verified: false,
      refusal: error instanceof Error ? error.message : String(error),
      accounts: []
    }
  }
}

async function previewLaunchAccount(
  deps: AgentLaunchReadinessDeps,
  scope: AgentLaunchReadinessTarget['scope'],
  hostId: AgentLaunchHostId,
  params: AgentLaunchReadinessParams
): Promise<AgentLaunchReadinessAccount> {
  return hostId === 'local'
    ? await previewLocalLaunchAccount({
        agent: params.agent,
        model: params.model,
        path: scope.path,
        runsInWsl: deps.runsInWsl(scope),
        capacity: deps.capacity
      })
    : await previewSshLaunchAccount(hostId, scope.connectionId!, params)
}

async function readLaunchLoad(
  deps: AgentLaunchReadinessDeps,
  hostId: AgentLaunchHostId
): Promise<AgentLaunchLoadReport> {
  try {
    return await deps.readLoad(hostId)
  } catch {
    // Why null, not zero: an unread host is unknown, and placement ranks it after known hosts.
    return { load: null, machineId: null }
  }
}

/** Where a launch would run and, with `preview`, which account it would pick; never launches. */
export async function resolveAgentLaunchReadiness(
  deps: AgentLaunchReadinessDeps,
  params: AgentLaunchReadinessParams
): Promise<AgentLaunchReadinessResult> {
  const { scope, managedWorktree } = await deps.resolveWorkspace(params.worktree)
  const hostId: AgentLaunchHostId = scope.connectionId ? `ssh:${scope.connectionId}` : 'local'
  // Why together: the bounded load read must not add to a slow account probe.
  const [account, placement] = await Promise.all([
    params.preview ? previewLaunchAccount(deps, scope, hostId, params) : null,
    params.load ? readLaunchLoad(deps, hostId) : null
  ])
  return {
    runtimeId: deps.runtimeId,
    workspace: {
      id: scope.id,
      hostId,
      kind: scope.repo ? getRepoKind(scope.repo) : 'folder',
      path: scope.path,
      name: managedWorktree?.displayName || null
    },
    ...(account ? { account } : {}),
    ...(placement ? { load: placement.load, machineId: placement.machineId } : {})
  }
}
