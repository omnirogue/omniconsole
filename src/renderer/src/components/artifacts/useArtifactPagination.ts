import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactListPage
} from '../../../../shared/artifacts'
import type { OrcaProfileAuthStatus } from '../../../../shared/omni-profiles'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { artifactListStateForFilter, type ArtifactListFilter } from './artifact-list-filter'
import { artifactListHasLifecycle } from './artifact-lifecycle-model'
import { keepRowsMutatedAfterRequest } from './artifact-list-fence'

const LOCAL_RUNTIME = { kind: 'local' } as const
const EMPTY_ARTIFACTS: readonly ArtifactListItem[] = []

export function artifactAccountIdentity(authStatus: OrcaProfileAuthStatus | null): string | null {
  return authStatus?.state === 'connected'
    ? `${authStatus.activeProfileId}:${authStatus.cloud?.userId ?? ''}:${authStatus.cloud?.cloudProfileId ?? ''}:${authStatus.cloud?.activeOrgId ?? ''}`
    : null
}

function appendArtifactPage(
  current: readonly ArtifactListItem[],
  incoming: readonly ArtifactListItem[]
): readonly ArtifactListItem[] {
  const knownSlugs = new Set(current.map(({ artifact }) => artifact.slug))
  return [...current, ...incoming.filter(({ artifact }) => !knownSlugs.has(artifact.slug))]
}

function artifactRequestIsCurrent(
  sequence: number,
  currentSequence: number,
  identity: string
): boolean {
  return (
    sequence === currentSequence &&
    artifactAccountIdentity(useAppStore.getState().orcaProfileAuthStatus) === identity
  )
}

export function useArtifactPagination(
  authStatus: OrcaProfileAuthStatus | null,
  refreshAuth: () => Promise<unknown>,
  filter: ArtifactListFilter = 'all'
): {
  accountIdentity: string | null
  artifacts: readonly ArtifactListItem[]
  error: string | null
  /** True once a response from this account's server carried the lifecycle keys. */
  lifecycleSupported: boolean
  loading: boolean
  loadingMore: boolean
  nextCursor?: string
  loadArtifacts: () => Promise<void>
  loadMoreArtifacts: () => Promise<void>
  removeArtifact: (identity: string, slug: string) => void
  replaceArtifact: (
    identity: string,
    slug: string,
    update: (item: ArtifactListItem) => ArtifactListItem
  ) => void
  setError: (error: string | null) => void
} {
  const accountIdentity = artifactAccountIdentity(authStatus)
  const [supportedIdentity, setSupportedIdentity] = useState<string | null>(null)
  const lifecycleSupported = accountIdentity !== null && supportedIdentity === accountIdentity
  // Why: an older server has no `state`; send it only once this server has shown lifecycle keys.
  const listState = lifecycleSupported ? artifactListStateForFilter(filter) : undefined
  const wantedState = artifactListStateForFilter(filter)
  // Why keyed by state: a cursor belongs to the filter that produced it.
  const stateKey = listState ?? 'all'
  const [artifactState, setArtifactState] = useState<{
    identity: string | null
    stateKey: string
    page: ArtifactListPage
  }>({ identity: null, stateKey: 'all', page: { artifacts: [] } })
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSequence = useRef(0)
  const loadingCursor = useRef<string | null>(null)
  const mutationClock = useRef(0)
  const mutatedAt = useRef(new Map<string, number>())
  const currentPage = artifactState.identity === accountIdentity ? artifactState.page : null
  // Why: until the restarted filter's first page lands, the old page's cursor must not be sent.
  const nextCursor = artifactState.stateKey === stateKey ? currentPage?.nextCursor : undefined
  const mutatedSince = useCallback(
    (clock: number) => (slug: string) => (mutatedAt.current.get(slug) ?? 0) > clock,
    []
  )
  const artifacts = currentPage?.artifacts ?? EMPTY_ARTIFACTS

  const loadArtifacts = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    loadingCursor.current = null
    setLoadingMore(false)
    if (!accountIdentity) {
      setArtifactState({ identity: null, stateKey, page: { artifacts: [] } })
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    let reloading = false
    const startClock = mutationClock.current
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactListPage>>(
        LOCAL_RUNTIME,
        'artifacts.list',
        listState ? { state: listState } : {}
      )
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      if (result.status === 'ok') {
        if (listState === undefined && artifactListHasLifecycle(result.value.artifacts)) {
          setSupportedIdentity(accountIdentity)
          // Why: the unfiltered page must not flash; the filtered load follows on the state change.
          reloading = wantedState !== undefined
          if (reloading) {
            return
          }
        }
        setArtifactState((current) => ({
          identity: accountIdentity,
          stateKey,
          page: {
            ...result.value,
            artifacts: keepRowsMutatedAfterRequest(
              result.value.artifacts,
              current.identity === accountIdentity ? current.page.artifacts : [],
              mutatedSince(startClock)
            )
          }
        }))
      } else {
        await refreshAuth()
        if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
          return
        }
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.signInAgain',
            'Sign in to OmniConsole again to load artifacts.'
          )
        )
      }
    } catch (loadError) {
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      console.error('Failed to load artifacts:', loadError)
      setError(
        translate('auto.components.artifacts.ArtifactsPage.loadFailed', 'Could not load artifacts.')
      )
    } finally {
      if (!reloading && artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        setLoading(false)
      }
    }
  }, [accountIdentity, refreshAuth, listState, wantedState, stateKey, mutatedSince])

  useEffect(() => {
    void loadArtifacts()
    return () => {
      loadSequence.current += 1
    }
  }, [loadArtifacts])

  const loadMoreArtifacts = useCallback(async (): Promise<void> => {
    const cursor = nextCursor
    if (!accountIdentity || !cursor || loadingCursor.current) {
      return
    }
    const sequence = loadSequence.current
    const startClock = mutationClock.current
    loadingCursor.current = cursor
    setLoadingMore(true)
    setError(null)
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactListPage>>(
        LOCAL_RUNTIME,
        'artifacts.list',
        listState ? { cursor, state: listState } : { cursor }
      )
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      if (result.status !== 'ok') {
        await refreshAuth()
        if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
          return
        }
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.signInAgain',
            'Sign in to OmniConsole again to load artifacts.'
          )
        )
        return
      }
      setArtifactState((current) =>
        current.identity === accountIdentity && current.stateKey === stateKey
          ? {
              identity: current.identity,
              stateKey,
              page: {
                artifacts: appendArtifactPage(
                  current.page.artifacts,
                  keepRowsMutatedAfterRequest(
                    result.value.artifacts,
                    current.page.artifacts,
                    mutatedSince(startClock)
                  )
                ),
                ...(result.value.nextCursor && result.value.nextCursor !== cursor
                  ? { nextCursor: result.value.nextCursor }
                  : {})
              }
            }
          : current
      )
    } catch (loadError) {
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      console.error('Failed to load more artifacts:', loadError)
      setError(
        translate(
          'auto.components.artifacts.ArtifactsPage.loadMoreFailed',
          'Could not load more artifacts.'
        )
      )
    } finally {
      if (loadingCursor.current === cursor) {
        loadingCursor.current = null
        setLoadingMore(false)
      }
    }
  }, [accountIdentity, nextCursor, refreshAuth, listState, stateKey, mutatedSince])

  const removeArtifact = useCallback((identity: string, slug: string): void => {
    loadSequence.current += 1
    loadingCursor.current = null
    setLoading(false)
    setLoadingMore(false)
    setArtifactState((current) =>
      current.identity === identity
        ? {
            ...current,
            page: {
              ...current.page,
              artifacts: current.page.artifacts.filter((item) => item.artifact.slug !== slug)
            }
          }
        : current
    )
  }, [])

  const replaceArtifact = useCallback(
    (
      identity: string,
      slug: string,
      update: (item: ArtifactListItem) => ArtifactListItem
    ): void => {
      mutationClock.current += 1
      mutatedAt.current.set(slug, mutationClock.current)
      setArtifactState((current) =>
        current.identity === identity
          ? {
              ...current,
              page: {
                ...current.page,
                artifacts: current.page.artifacts.map((item) =>
                  item.artifact.slug === slug ? update(item) : item
                )
              }
            }
          : current
      )
    },
    []
  )

  return {
    accountIdentity,
    artifacts,
    error,
    lifecycleSupported,
    loading,
    loadingMore,
    nextCursor,
    loadArtifacts,
    loadMoreArtifacts,
    removeArtifact,
    replaceArtifact,
    setError
  }
}
