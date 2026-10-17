import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'
import { getProviderSessionClaimKey } from './provider-session-claim-key'

export function providerSessionFolderKey(args: {
  hostId: ExecutionHostId
  worktreeId: string
  agent: string
  providerSession: AgentProviderSessionMetadata
}): string {
  return JSON.stringify([args.hostId, 'provider', getProviderSessionClaimKey(args)])
}

export function structuredSessionFolderKey(hostId: ExecutionHostId, sessionId: string): string {
  return JSON.stringify([hostId, 'structured', sessionId])
}

// Why: a terminal-hosted agent (e.g. Claude in a plain shell) has no provider
// session until the agent reports one, but the pane itself — a specific leaf
// of a specific tab — is a stable, collision-free identity the moment it
// exists. This lets a person file the conversation into a folder immediately;
// buildSidebarSessions migrates the membership onto the provider key the
// instant it arrives (see session-folder-key-migration.ts), and drops this
// provisional entry so a later, unrelated session reusing the same pane never
// inherits the old folder.
export function paneSessionFolderKey(
  hostId: ExecutionHostId,
  worktreeId: string,
  paneKey: string
): string {
  return JSON.stringify([hostId, 'pane', worktreeId, paneKey])
}
