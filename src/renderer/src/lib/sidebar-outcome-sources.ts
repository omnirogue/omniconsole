import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { SessionChain } from '../../../shared/session-chain-types'

/** Index durable sources once; a terminal projection still has to prove the pane exists. */
export function indexSidebarOutcomeSources(chains: readonly SessionChain[]): Map<string, string> {
  const sources = new Map<string, string>()
  for (const chain of chains) {
    const hostId = normalizeExecutionHostId(chain.placement ?? chain.hostId)
    if (!hostId || !chain.sourcePaneKey || !chain.outcomeSet?.outcomes.length) {
      continue
    }
    const rowKey = JSON.stringify([hostId, chain.worktreeId, chain.sourcePaneKey])
    if (chain.sourceRowKey === rowKey) {
      sources.set(rowKey, chain.outcomeSet.outcomes[0]!.title)
    }
  }
  return sources
}
