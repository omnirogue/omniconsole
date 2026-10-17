import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

/** One row's finished classification: what the tree pushes, and which group it belongs to. */
export type SessionSidebarRowEntry = {
  row: SessionSidebarTreeRow
  classification: string
}

export type SessionSidebarRowStats = {
  /** Tree builds started. */
  builds: number
  /** Rows whose inputs moved, so their classification had to run again. */
  computed: number
  /** Rows carried over untouched from the previous build. */
  reused: number
}

// Why a module-level tally: the cost this cache exists to remove is invisible to a render
// count, so the scale tests assert on the work itself.
const stats: SessionSidebarRowStats = { builds: 0, computed: 0, reused: 0 }

export function readSessionSidebarRowStats(): SessionSidebarRowStats {
  return { ...stats }
}

export function resetSessionSidebarRowStats(): void {
  stats.builds = 0
  stats.computed = 0
  stats.reused = 0
}

export type SessionSidebarRowCache = {
  beginBuild(): void
  resolve(
    rowKey: string,
    deps: readonly unknown[],
    compute: () => SessionSidebarRowEntry
  ): SessionSidebarRowEntry
  /** Drop rows that are no longer listed, so a long session does not grow the cache forever. */
  retain(rowKeys: ReadonlySet<string>): void
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  )
}

/**
 * Carries each row's classification across tree rebuilds. A status ping or a minute tick then
 * costs one classification for the row that actually moved, instead of all five hundred.
 */
export function createSessionSidebarRowCache(): SessionSidebarRowCache {
  const entries = new Map<string, { deps: readonly unknown[]; entry: SessionSidebarRowEntry }>()
  return {
    beginBuild() {
      stats.builds += 1
    },
    resolve(rowKey, deps, compute) {
      const cached = entries.get(rowKey)
      if (cached && sameDeps(cached.deps, deps)) {
        stats.reused += 1
        return cached.entry
      }
      const entry = compute()
      entries.set(rowKey, { deps, entry })
      stats.computed += 1
      return entry
    },
    retain(rowKeys) {
      for (const key of entries.keys()) {
        if (!rowKeys.has(key)) {
          entries.delete(key)
        }
      }
    }
  }
}

/** For callers that build a tree once; every row is classified, nothing is remembered. */
export function passThroughSessionSidebarRowCache(): SessionSidebarRowCache {
  return {
    beginBuild() {
      stats.builds += 1
    },
    resolve(_rowKey, _deps, compute) {
      stats.computed += 1
      return compute()
    },
    retain() {}
  }
}
