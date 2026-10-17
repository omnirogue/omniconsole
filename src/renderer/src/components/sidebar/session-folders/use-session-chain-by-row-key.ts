import { useEffect, useMemo, useRef } from 'react'
import { getSessionChain, useSessionFollowUpChains } from '@/lib/session-chain-registry'
import { preferredSessionChain } from '@/lib/session-chain-row-choice'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SessionChain } from '../../../../../shared/session-chain-types'

/**
 * The chain each source row speaks for (the unfinished one, else the newest), kept readable after
 * the row subscription drops a completed plan.
 */
export function useSessionChainByRowKey(
  chainRows: readonly SessionChainRowInfo[]
): Map<string, SessionChain> {
  const followUps = useSessionFollowUpChains()
  const rememberedChainIds = useRef<readonly string[]>([])
  const chainByRowKey = useMemo(() => {
    // Why: the ids seen last render keep their final records readable once the subscription drops them.
    const ids = new Set([
      ...rememberedChainIds.current,
      ...chainRows.map((row) => row.chainId),
      ...followUps.map((chain) => chain.id)
    ])
    const byRow = new Map<string, SessionChain[]>()
    for (const id of ids) {
      const chain = getSessionChain(id)
      if (chain) {
        byRow.set(chain.sourceRowKey, [...(byRow.get(chain.sourceRowKey) ?? []), chain])
      }
    }
    const map = new Map<string, SessionChain>()
    for (const [rowKey, chains] of byRow) {
      map.set(rowKey, preferredSessionChain(chains)!)
    }
    return map
  }, [chainRows, followUps])
  useEffect(() => {
    rememberedChainIds.current = [...chainByRowKey.values()].map((chain) => chain.id)
  }, [chainByRowKey])
  return chainByRowKey
}

/**
 * The row info of that same chain. Picked from the chain map, never by list order, so a row's
 * queue line and its plan state can only ever describe one chain.
 */
export function sessionChainRowsByRowKey(
  chainRows: readonly SessionChainRowInfo[],
  chainByRowKey: ReadonlyMap<string, SessionChain>
): Map<string, SessionChainRowInfo> {
  const map = new Map<string, SessionChainRowInfo>()
  for (const row of chainRows) {
    const chosen = chainByRowKey.get(row.rowKey)
    if (!chosen || getSessionChain(row.chainId)?.id === chosen.id) {
      map.set(row.rowKey, row)
    }
  }
  return map
}
