import { probeSessionLoopbackUrls } from '@/lib/session-loopback-status'
import { useEffect, useMemo, useState } from 'react'
import { resolveWorktreeHostedReview } from '@/components/dashboard/dashboard-card-context'
import {
  pinLocalImageCacheKey,
  unpinLocalImageCacheKey
} from '@/components/editor/local-image-cache-pinning'
import {
  getLocalImageCacheKey,
  loadLocalImageAbsolutePath,
  onImageCacheInvalidated
} from '@/components/editor/useLocalImageSrc'
import {
  sessionFileContext,
  sessionFileExists,
  type SessionFileTarget
} from '@/lib/session-files-and-links-actions'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { SessionFileKind } from '../../../../shared/session-file-kind'

/** Enough to cover a long session's output without stat-ing hundreds of paths on every open. */
const MAX_CHECKED_FILES = 60
const MAX_PROBED_URLS = 12

export function useSessionFileTarget(
  worktreeId: string,
  hostId?: string | null
): SessionFileTarget | null {
  const worktreePath = useAppStore((state) => state.getKnownWorktreeById(worktreeId)?.path ?? null)
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  const resolvedHost = useAppStore((state) => getExecutionHostIdForWorktree(state, worktreeId))
  return useMemo(
    () =>
      worktreePath && hostId && resolvedHost === hostId
        ? { worktreeId, worktreePath, runtimeEnvironmentId }
        : null,
    [worktreeId, worktreePath, runtimeEnvironmentId, resolvedHost, hostId]
  )
}

/** The workspace's PR from the review caches the app already keeps; this starts no request. */
export function useWorkspaceReview(worktreeId: string): HostedReviewInfo | null {
  const worktree = useAppStore((state) => state.getKnownWorktreeById(worktreeId) ?? null)
  const repoId = worktree?.repoId
  const repo = useAppStore((state) =>
    repoId ? (state.repos.find((candidate) => candidate.id === repoId) ?? null) : null
  )
  const hostedReviewCache = useAppStore((state) => state.hostedReviewCache)
  const prCache = useAppStore((state) => state.prCache)
  const settings = useAppStore((state) => state.settings)
  return useMemo(
    // Why the branch check: a workspace row without one (legacy, or a pane resumed from an older
    // record) would make the review lookup throw, and this hook now runs for every conversation.
    () =>
      worktree && typeof worktree.branch === 'string'
        ? (resolveWorktreeHostedReview({ hostedReviewCache, prCache, settings }, repo, worktree) ??
          null)
        : null,
    [worktree, repo, hostedReviewCache, prCache, settings]
  )
}

const NO_RESULTS: ReadonlyMap<string, never> = new Map<string, never>()

/**
 * Checks each path when the panel is showing — again every time it is reopened, because files
 * get deleted — and answers only for the newest MAX_CHECKED_FILES. Unchecked paths stay hidden.
 */
export function useExistingSessionFiles(
  paths: readonly string[],
  target: SessionFileTarget | null,
  active: boolean
): ReadonlyMap<string, boolean> {
  const [existing, setExisting] = useState<ReadonlyMap<string, boolean>>(NO_RESULTS)
  const key = paths.slice(0, MAX_CHECKED_FILES).join('\n')
  useEffect(() => {
    setExisting(NO_RESULTS)
    if (!active || !target || key === '') {
      return
    }
    let cancelled = false
    const checked = key.split('\n')
    void Promise.all(
      checked.map(async (path) => [path, await sessionFileExists(target, path)] as const)
    ).then((entries) => {
      if (!cancelled) {
        setExisting(new Map(entries))
      }
    })
    return () => {
      cancelled = true
    }
  }, [active, key, target])
  return existing
}

export type LoopbackLiveness = 'live' | 'stopped' | 'unverifiable'

/** Probes loopback URLs (main refuses anything else) each time the panel is shown. */
export function useLoopbackLiveness(
  urls: readonly string[],
  active: boolean,
  hostId: string | null | undefined
): ReadonlyMap<string, LoopbackLiveness> {
  const [result, setResult] = useState<{
    hostId: string | null | undefined
    key: string
    values: ReadonlyMap<string, LoopbackLiveness>
  } | null>(null)
  const key = urls.slice(0, MAX_PROBED_URLS).join('\n')
  useEffect(() => {
    if (!active || !key) {
      return
    }
    let cancelled = false
    void probeSessionLoopbackUrls(
      key.split('\n'),
      hostId,
      window.api.sessionFiles?.probeLoopback
    ).then((values) => {
      if (!cancelled) {
        setResult({ hostId, key, values })
      }
    })
    return () => {
      cancelled = true
    }
  }, [active, key, hostId])
  return result && result.hostId === hostId && result.key === key && active
    ? result.values
    : NO_RESULTS
}

/**
 * A real preview for images (the editor's authorized blob loader) and a first-frame still for
 * local videos (the OS thumbnailer, via main). Anything that cannot be previewed keeps its icon.
 */
export function useSessionFileThumbnail(
  path: string,
  kind: SessionFileKind,
  target: SessionFileTarget | null
): string | null {
  const [src, setSrc] = useState<string | null>(null)
  // Why: the image blob cache drops (and later revokes) every URL when the window regains focus,
  // so a thumbnail reloads then instead of pointing at a revoked blob.
  const [generation, setGeneration] = useState(0)
  useEffect(
    () =>
      kind === 'image'
        ? onImageCacheInvalidated(() => setGeneration((value) => value + 1))
        : undefined,
    [kind]
  )
  useEffect(() => {
    if (!target || (kind !== 'image' && kind !== 'video')) {
      return
    }
    let cancelled = false
    const context = sessionFileContext(target, path)
    const imageKey =
      kind === 'image' ? getLocalImageCacheKey(path, context.connectionId, context) : null
    if (imageKey) {
      // Why: a pinned entry survives the cache's size pruning while this card shows it.
      pinLocalImageCacheKey(imageKey)
    }
    const load =
      kind === 'image'
        ? loadLocalImageAbsolutePath(path, context.connectionId, context)
        : canClientOsOpenWorkspaceFile(context, path) && window.api.sessionFiles
          ? window.api.sessionFiles.videoThumbnail({ filePath: path })
          : Promise.resolve(null)
    void load
      .catch(() => null)
      .then((url) => {
        if (!cancelled) {
          setSrc(url)
        }
      })
    return () => {
      cancelled = true
      if (imageKey) {
        unpinLocalImageCacheKey(imageKey)
      }
    }
  }, [path, kind, target, generation])
  return src
}
