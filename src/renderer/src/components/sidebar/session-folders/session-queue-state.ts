import { useMemo } from 'react'
import { getSessionChain } from '@/lib/session-chain-registry'
import { isQueuedSessionChain } from '@/lib/session-chain-row-choice'
import {
  cancelSessionChain,
  findShownSessionChainForRow,
  useSessionChainRows
} from '@/lib/session-chain-runner'

// Why: the sidebar's queue surface is a thin view over session chains, which outlive
// the sidebar and the app session because their intent is persisted on the host.

export const NO_QUEUED_ROW_KEYS: ReadonlySet<string> = new Set()

/**
 * Row keys that currently have a chain queued after them. A sealed, failed or cancelled run is
 * history, so a closed or archived row never reads "N sessions queued".
 */
export function useQueuedSessionRowKeys(): ReadonlySet<string> {
  const rows = useSessionChainRows()
  return useMemo(
    () =>
      new Set(
        rows
          .filter((row) => {
            const chain = getSessionChain(row.chainId)
            return !chain || isQueuedSessionChain(chain)
          })
          .map((row) => row.rowKey)
      ),
    [rows]
  )
}

/** Cancel the live chain after a row, or dismiss a failed one. */
export function cancelQueuedSession(rowKey: string): void {
  const chain = findShownSessionChainForRow(rowKey)
  if (chain) {
    cancelSessionChain(chain.id)
  }
}
