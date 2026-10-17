import type { Worktree } from '../../../shared/worktree/types'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { SessionChain, SessionChainStep } from '../../../shared/session-chain-types'
import { chainWorkspacePath } from '@/lib/session-chain-notices'
import { findSessionChainForRow } from '@/lib/session-chain-registry'

/** Build an unregistered chain for atomic outcome commit; no runner owns it before the host does. */
export function buildCompiledSessionChain(args: {
  session: SidebarSession
  chainId: string
  end?: SessionChain['end']
  placement?: SessionChain['placement']
  destination?: Worktree
  steps: readonly SessionChainStep[]
  auto: boolean
}): SessionChain | null {
  const { session } = args
  const source = sidebarSessionSourceIdentity(session)
  const endsOnly = args.steps.length === 0 && args.end === 'done'
  if (!source || (args.steps.length === 0 && !endsOnly) || findSessionChainForRow(session.rowKey)) {
    return null
  }
  const workspacePath = chainWorkspacePath(session)
  if (!workspacePath) {
    return null
  }
  const now = Date.now()
  return {
    id: args.chainId,
    workspacePath: args.destination?.path ?? workspacePath,
    worktreeId: args.destination?.id ?? session.worktreeId,
    hostId: args.placement ?? session.hostId,
    ...(args.end ? { end: args.end } : {}),
    ...(args.placement ? { placement: args.placement, sourceWorktreeId: session.worktreeId } : {}),
    sourcePaneKey: source.sourceKey,
    sourceRowKey: session.rowKey,
    auto: args.auto,
    steps: [...args.steps],
    currentIndex: 0,
    state: 'waiting',
    createdAt: now,
    updatedAt: now
  }
}
