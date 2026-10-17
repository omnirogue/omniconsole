import type { createPeerThreadDeltas } from '@/lib/peer-thread-deltas'

type HistoryReader = ReturnType<typeof createPeerThreadDeltas>
type HistoryValue = Awaited<ReturnType<HistoryReader['loadMore']>>

/**
 * How this reaches the work store. Taking the store's reads and writes as a port
 * keeps this module out of an import cycle with `backoffice-work-store`, which
 * imports it — `audit:code-quality:native` runs with --deny-warnings, so a cycle
 * fails static analysis.
 */
export type MessageHistoryPort = {
  snapshot: () => { scope: string | null; loadingMore: boolean; hasMore: boolean }
  begin: () => void
  ready: (value: HistoryValue, hasMore: boolean) => void
  failed: (message: string) => void
  settle: () => void
}

/** Older history must not notify the person as if these messages just arrived. */
export async function appendBackofficeMessageHistory(
  port: MessageHistoryPort,
  scope: string,
  reader: HistoryReader,
  current: () => boolean,
  attached: () => boolean,
  isCancelled?: () => boolean
): Promise<void> {
  const state = port.snapshot()
  if (state.scope !== scope || state.loadingMore || !state.hasMore) {
    return
  }
  port.begin()
  try {
    const value = await reader.loadMore(isCancelled)
    if (current()) {
      port.ready(value, reader.hasMore())
    }
  } catch (error) {
    if (current()) {
      port.failed(error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (attached()) {
      port.settle()
    }
  }
}
