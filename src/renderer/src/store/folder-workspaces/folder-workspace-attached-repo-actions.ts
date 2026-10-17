import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  FolderWorkspaceAttachedRepo,
  FolderWorkspaceAttachedReposById
} from '../../../../shared/folder-workspace-attached-repos'
import type { FolderWorkspaceRepoDetection } from '../../../../shared/folder-workspace-repo-candidates'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForFolderWorkspace } from '@/lib/folder-workspace-runtime-owner'

/** Attachments live with the host that owns the folder: `local`, or `runtime:<environmentId>`. */
export type FolderAttachedRepoSourceKey = 'local' | `runtime:${string}`

export type FolderWorkspaceAttachedRepoSlice = {
  /** Per owning host, then per FolderWorkspace.id; a host never sees another host's rows. */
  folderWorkspaceAttachedReposBySource: Record<string, FolderWorkspaceAttachedReposById>
  /** Hosts whose last attachment read failed; cleared by the next successful read. */
  folderWorkspaceAttachedRepoFailedSources: Record<string, true>
  refreshFolderWorkspaceAttachedRepos: (options?: {
    remoteHosts?: 'include' | 'skip'
  }) => Promise<void>
  attachFolderWorkspaceRepo: (args: {
    folderWorkspaceId: string
    repoId: string
    source?: FolderWorkspaceAttachedRepo['source']
  }) => Promise<boolean>
  detachFolderWorkspaceRepo: (folderWorkspaceId: string, key: string) => Promise<boolean>
  detectFolderWorkspaceRepos: (folderWorkspaceId: string) => Promise<FolderWorkspaceRepoDetection>
  /** Session-only: which worktree Source Control shows while a folder workspace is active. */
  folderGitTargetByFolderId: Record<string, string>
  setFolderGitTarget: (folderWorkspaceId: string, worktreeId: string) => void
}

const NO_ATTACHED_REPOS: FolderWorkspaceAttachedRepo[] = []

export function getFolderAttachedRepoSourceKey(
  state: AppState,
  folderWorkspaceId: string
): FolderAttachedRepoSourceKey {
  const environmentId = getRuntimeEnvironmentIdForFolderWorkspace(state, folderWorkspaceId)
  return environmentId ? `runtime:${environmentId}` : 'local'
}

/** The folder's attached repos, read from the host that owns the folder. */
export function selectFolderWorkspaceAttachedRepos(
  state: AppState,
  folderWorkspaceId: string
): FolderWorkspaceAttachedRepo[] {
  const source = getFolderAttachedRepoSourceKey(state, folderWorkspaceId)
  return (
    state.folderWorkspaceAttachedReposBySource[source]?.[folderWorkspaceId] ?? NO_ATTACHED_REPOS
  )
}

export type FolderAttachedReposStatus = 'loading' | 'failed' | 'ready'

/** Whether the owning host's attachments are known; an empty list only means "none" when ready. */
export function selectFolderWorkspaceAttachedReposStatus(
  state: AppState,
  folderWorkspaceId: string
): FolderAttachedReposStatus {
  const source = getFolderAttachedRepoSourceKey(state, folderWorkspaceId)
  if (state.folderWorkspaceAttachedReposBySource[source]) {
    return 'ready'
  }
  return state.folderWorkspaceAttachedRepoFailedSources[source] ? 'failed' : 'loading'
}

function isMethodNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === 'method_not_found' ||
      /method_not_found|Unknown method/.test(error.message))
  )
}

export function createFolderWorkspaceAttachedRepoSlice(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): FolderWorkspaceAttachedRepoSlice {
  const targetFor = (folderWorkspaceId: string) =>
    getActiveRuntimeTarget({
      activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForFolderWorkspace(
        get(),
        folderWorkspaceId
      )
    })

  // Why per source: a slow read of one host must not overwrite a newer read or a completed
  // attach/detach on that host, and must never touch another host's rows.
  const generationBySource = new Map<string, number>()
  const nextGeneration = (source: string): number => {
    const generation = (generationBySource.get(source) ?? 0) + 1
    generationBySource.set(source, generation)
    return generation
  }

  // Why a refresh-wide generation: only the newest host enumeration may prune hosts.
  let refreshGeneration = 0

  const publishSource = (source: string, byId: FolderWorkspaceAttachedReposById | null): void => {
    set((state) => {
      const { [source]: _previous, ...rest } = state.folderWorkspaceAttachedReposBySource
      const { [source]: _failed, ...failed } = state.folderWorkspaceAttachedRepoFailedSources
      return {
        folderWorkspaceAttachedReposBySource: byId ? { ...rest, [source]: byId } : rest,
        folderWorkspaceAttachedRepoFailedSources: failed
      }
    })
  }

  const markSourceFailed = (source: string): void => {
    set((state) => ({
      folderWorkspaceAttachedRepoFailedSources: {
        ...state.folderWorkspaceAttachedRepoFailedSources,
        [source]: true
      }
    }))
  }

  // Why an explicit source: the reply belongs to the host asked, even if the view moved since.
  const replaceFolder = (
    source: FolderAttachedRepoSourceKey,
    folderWorkspaceId: string,
    list: FolderWorkspaceAttachedRepo[]
  ): void => {
    nextGeneration(source)
    const { [folderWorkspaceId]: _previous, ...rest } =
      get().folderWorkspaceAttachedReposBySource[source] ?? {}
    publishSource(source, list.length > 0 ? { ...rest, [folderWorkspaceId]: list } : rest)
  }

  const readSource = async (
    source: FolderAttachedRepoSourceKey
  ): Promise<FolderWorkspaceAttachedReposById | null> => {
    try {
      if (source === 'local') {
        // Why optional: the web client has no desktop preload; its folders come from the runtime.
        return window.api.folderWorkspaces?.listAttachedRepos
          ? await window.api.folderWorkspaces.listAttachedRepos()
          : {}
      }
      return (
        await callRuntimeRpc<{ attachedRepos: FolderWorkspaceAttachedReposById }>(
          { kind: 'environment', environmentId: source.slice('runtime:'.length) },
          'folderWorkspace.attachedRepos',
          undefined,
          // Why: an offline paired runtime must not be re-probed on every catalog load.
          { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
        )
      ).attachedRepos
    } catch (err) {
      // Why: an older paired runtime simply has no attachments to show.
      if (isMethodNotFound(err)) {
        return {}
      }
      console.warn(`Failed to load folder attached repos from ${source}:`, err)
      return null
    }
  }

  return {
    folderWorkspaceAttachedReposBySource: {},
    folderWorkspaceAttachedRepoFailedSources: {},
    folderGitTargetByFolderId: {},
    setFolderGitTarget: (folderWorkspaceId, worktreeId) =>
      set((state) => ({
        folderGitTargetByFolderId: {
          ...state.folderGitTargetByFolderId,
          [folderWorkspaceId]: worktreeId
        }
      })),

    refreshFolderWorkspaceAttachedRepos: async (options) => {
      const refresh = ++refreshGeneration
      let environments: { id: string }[] | null = null
      // Why: a first-paint load must not touch paired runtimes, not even to list them.
      if (options?.remoteHosts !== 'skip') {
        try {
          environments = (await window.api.runtimeEnvironments?.list?.()) ?? []
        } catch (err) {
          console.warn('Failed to list runtime environments for folder attachments:', err)
        }
      }
      const sources: FolderAttachedRepoSourceKey[] = [
        'local',
        ...(environments ?? []).map((environment) => `runtime:${environment.id}` as const)
      ]
      // Why only on the newest confirmed list: a failed or superseded enumeration is not
      // evidence that a host went away.
      if (environments && refresh === refreshGeneration) {
        const live = new Set<string>(sources)
        for (const source of Object.keys(get().folderWorkspaceAttachedReposBySource)) {
          if (!live.has(source)) {
            nextGeneration(source)
            publishSource(source, null)
          }
        }
      }
      await Promise.all(
        sources.map(async (source) => {
          const generation = nextGeneration(source)
          const byId = await readSource(source)
          // Why: a failed read keeps the last known rows; a stale one never lands.
          if (generationBySource.get(source) !== generation) {
            return
          }
          if (byId) {
            publishSource(source, byId)
          } else {
            markSourceFailed(source)
          }
        })
      )
    },

    attachFolderWorkspaceRepo: async ({ folderWorkspaceId, repoId, source }) => {
      const owner = getFolderAttachedRepoSourceKey(get(), folderWorkspaceId)
      const target = targetFor(folderWorkspaceId)
      const attached =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.attachRepo({ folderWorkspaceId, repoId, source })
          : (
              await callRuntimeRpc<{ attachedRepos: FolderWorkspaceAttachedRepo[] | null }>(
                target,
                'folderWorkspace.attachRepo',
                { folderWorkspaceId, repoId, ...(source ? { source } : {}) },
                { timeoutMs: 15_000 }
              )
            ).attachedRepos
      if (!attached) {
        return false
      }
      replaceFolder(owner, folderWorkspaceId, attached)
      return true
    },

    detachFolderWorkspaceRepo: async (folderWorkspaceId, key) => {
      const owner = getFolderAttachedRepoSourceKey(get(), folderWorkspaceId)
      const target = targetFor(folderWorkspaceId)
      const detached =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.detachRepo({ folderWorkspaceId, key })
          : (
              await callRuntimeRpc<{ detached: boolean }>(
                target,
                'folderWorkspace.detachRepo',
                { folderWorkspaceId, key },
                { timeoutMs: 15_000 }
              )
            ).detached
      if (detached) {
        const rows = get().folderWorkspaceAttachedReposBySource[owner]?.[folderWorkspaceId] ?? []
        replaceFolder(
          owner,
          folderWorkspaceId,
          rows.filter((entry) => entry.key !== key)
        )
      }
      return detached
    },

    detectFolderWorkspaceRepos: async (folderWorkspaceId) => {
      const target = targetFor(folderWorkspaceId)
      if (target.kind === 'local') {
        return window.api.folderWorkspaces.detectRepos({ folderWorkspaceId })
      }
      try {
        const found = await callRuntimeRpc<Partial<FolderWorkspaceRepoDetection>>(
          target,
          'folderWorkspace.detectRepos',
          { folderWorkspaceId },
          { timeoutMs: 15_000 }
        )
        // Why: a host that does not say whether the scan finished cannot promise it did.
        const candidates = Array.isArray(found.candidates) ? found.candidates : null
        return {
          candidates: candidates ?? [],
          incomplete: !candidates || found.incomplete !== false
        }
      } catch (err) {
        if (isMethodNotFound(err)) {
          throw new Error('Update this host to look for repos in its folders.')
        }
        throw err
      }
    }
  }
}
