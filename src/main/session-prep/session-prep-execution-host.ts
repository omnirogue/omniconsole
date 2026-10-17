import type { SessionPrepRepo, SessionPrepWorkspace } from './session-prep-host'

/** Routing errors must not fall back to an unchecked launch on the source computer. */
export class SessionPrepHostError extends Error {}

export function assertSessionPrepWorkspaceUnchanged(
  previous: SessionPrepWorkspace | undefined,
  current: SessionPrepWorkspace
): void {
  if (
    previous &&
    (previous.repoId !== current.repoId ||
      previous.path !== current.path ||
      previous.connectionId !== current.connectionId ||
      previous.connectionGeneration !== current.connectionGeneration ||
      previous.connectionBinding !== current.connectionBinding ||
      sessionPrepHostId(previous) !== sessionPrepHostId(current))
  ) {
    throw new SessionPrepHostError(
      'The prepared workspace or SSH target changed. Prepare the session again.'
    )
  }
}

export function sessionPrepHostId(
  workspace: Pick<SessionPrepWorkspace, 'hostId' | 'connectionId'>
): string {
  return workspace.hostId ?? (workspace.connectionId ? `ssh:${workspace.connectionId}` : 'local')
}

const PAIRED_HOST_REFUSAL =
  'Plan threads can’t start a session on a paired Mac. Choose the SSH workspace for this Mac, or ask the project chat to start the thread there: its workers follow the project’s Computers list.'

export function assertSessionPrepExecutionHost(workspace: SessionPrepWorkspace): void {
  const hostId = sessionPrepHostId(workspace)
  if (hostId.startsWith('runtime:')) {
    // Why point the way: session prep can't start on a paired runtime; the project chat's workers can.
    throw new SessionPrepHostError(PAIRED_HOST_REFUSAL)
  }
  if (workspace.isRemote && !workspace.connectionId) {
    throw new SessionPrepHostError('The remote workspace has no SSH execution owner.')
  }
  if (workspace.connectionId && hostId !== `ssh:${workspace.connectionId}`) {
    throw new SessionPrepHostError('The workspace execution owner has changed. Select it again.')
  }
}

/** Aliases resolve to one registered execution owner, never to a guessed address or path. */
export function resolveSessionPrepHost(repos: SessionPrepRepo[], hint: string): string {
  const needle = hint.trim().toLocaleLowerCase('en-US')
  if (['local', 'this mac', 'this computer'].includes(needle)) {
    return 'local'
  }
  const matches = new Set(
    repos
      .filter((repo) =>
        [sessionPrepHostId(repo), repo.host, ...(repo.hostAliases ?? [])].some(
          (name) => name?.toLocaleLowerCase('en-US') === needle
        )
      )
      .map(sessionPrepHostId)
  )
  if (matches.size !== 1) {
    throw new SessionPrepHostError(
      matches.size === 0
        ? `No registered workspace on “${hint}”. Set up that Mac's SSH workspace first, or ask the project chat to start the thread there.`
        : `“${hint}” names several execution hosts. Choose its exact SSH target.`
    )
  }
  return [...matches][0]!
}
