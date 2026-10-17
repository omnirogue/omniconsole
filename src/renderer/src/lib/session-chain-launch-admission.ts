import {
  normalizeSessionChainStep,
  sessionChainPredecessors,
  type SessionChain
} from '../../../shared/session-chain-types'

/** Capture launch inputs independently of replaceable progress records and later steps. */
export function sessionChainLaunchDefinition(chain: SessionChain): string | null {
  const step = normalizeSessionChainStep(chain.steps[chain.currentIndex])
  if (!step || step.kind === 'handoff') {
    return null
  }
  const {
    status: _status,
    launchedAt: _launchedAt,
    launchedTabId: _launchedTabId,
    launchedPaneKey: _launchedPaneKey,
    hubThreadId: _hubThreadId,
    hubSettledAt: _hubSettledAt,
    effortParity: _effortParity,
    ...definition
  } = step
  return JSON.stringify([
    chain.id,
    chain.createdAt,
    chain.sourceRowKey,
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId,
    chain.worktreeId,
    chain.workspacePath,
    chain.hostId,
    chain.placement,
    chain.currentIndex,
    definition,
    sessionChainPredecessors(chain, chain.currentIndex).map((predecessor) => [
      predecessor.id,
      predecessor.launchedPaneKey
    ])
  ])
}
