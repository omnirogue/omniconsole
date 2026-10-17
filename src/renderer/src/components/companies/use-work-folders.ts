import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { WorkFolders } from '../../../../shared/console-work-folders-contract'
import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { companiesApi, companiesData } from './companies-client'

type FoldersCache = {
  data: WorkFolders | null
  error: unknown
  loading: boolean
  scope: string
}

let cache: FoldersCache = { data: null, error: null, loading: false, scope: '' }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(next: FoldersCache): void {
  cache = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function load(scope: string, force: boolean): void {
  if (inflight && cache.scope === scope && !force) {
    return
  }
  if (!force && cache.scope === scope && (cache.data || cache.error)) {
    return
  }
  emit({ data: force ? cache.data : null, error: null, loading: true, scope })
  const run = Promise.resolve()
    .then(() => companiesApi().folders())
    .then((result) => {
      if (cache.scope === scope) {
        emit({ data: companiesData(result), error: null, loading: false, scope })
      }
    })
    .catch((reason: unknown) => {
      if (cache.scope === scope) {
        emit({ data: null, error: reason, loading: false, scope })
      }
    })
    .finally(() => {
      if (inflight === run) {
        inflight = null
      }
    })
  inflight = run
}

/**
 * The same folder tree, for code that is not a component (filing a card as it is created).
 * It answers from the shared read when that scope is already loaded, and otherwise reads
 * once and fills it, so a background caller never starts a second tree of its own.
 */
export async function readWorkFolders(scope: string): Promise<WorkFolders> {
  if (cache.scope === scope && cache.data) {
    return cache.data
  }
  const data = companiesData(await companiesApi().folders())
  emit({ data, error: null, loading: false, scope })
  return data
}

/** The folders scope outside React; `useWorkFoldersScope` is the same value as a hook. */
export function workFoldersScope(): string {
  return selectConsoleAccountScope(useAppStore.getState())
}

/** Test seam: forget the shared read so the next subscriber fetches again. */
export function resetWorkFoldersCacheForTest(): void {
  cache = { data: null, error: null, loading: false, scope: '' }
  inflight = null
}

/**
 * The console's folder tree (`/api/work/folders`), read once and shared by every
 * subscriber — the sidebar tree, the session headers and the launch bar all ask
 * for the same companies. `scope` names the account and environment so a switch
 * reads again; `reload` forces one.
 */
export function useWorkFolders(scope: string): {
  data: WorkFolders | null
  error: unknown
  loading: boolean
  reload: () => void
} {
  const snapshot = useSyncExternalStore(subscribe, () => cache)
  useEffect(() => {
    load(scope, false)
  }, [scope])
  const reload = useCallback(() => load(scope, true), [scope])
  const current = snapshot.scope === scope ? snapshot : { data: null, error: null, loading: true }
  return { data: current.data, error: current.error, loading: current.loading, reload }
}

/** The account and console environment the folders belong to; a change re-reads. */
export function useWorkFoldersScope(): string {
  return useAppStore(selectConsoleAccountScope)
}
