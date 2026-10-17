import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getWorktreeExecutionHostId } from '../../../shared/execution-host'
import { sessionChainPredecessors, type SessionChain } from '../../../shared/session-chain-types'

export function sessionChainHandoffSource(chain: SessionChain | null): SessionChain | null {
  if (!chain?.sourceWorktreeId || sessionChainPredecessors(chain, chain.currentIndex).length > 0) {
    return chain
  }
  const state = useAppStore.getState()
  const source = state.getKnownWorktreeById(chain.sourceWorktreeId)
  if (!source) {
    throw new Error(
      translate('nextStep.sourceUnavailable', 'The source workspace is no longer available.')
    )
  }
  // Why: a people step before the first placed agent still captures the original session's files.
  return {
    ...chain,
    worktreeId: source.id,
    workspacePath: source.path,
    hostId: getWorktreeExecutionHostId(
      source,
      state.repos.find((repo) => repo.id === source.repoId)
    )
  }
}
