import { useEffect, useMemo, useState } from 'react'
import { usePaneKeyboardEnabled } from '@/components/pane-focus-context'
import type { ArtifactCloudOperation, ArtifactListItem } from '../../../../shared/artifacts'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { persistConfirmationSkipPreference } from '@/components/confirmation-skip-preference'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ArtifactBulkBar } from './ArtifactBulkBar'
import { ArtifactCollection, type ArtifactCollectionLifecycle } from './ArtifactCollection'
import { ArtifactDetailDrawer, type ArtifactDrawerLifecycle } from './ArtifactDetailDrawer'
import { artifactName } from './artifact-display-labels'
import { DEFAULT_ARTIFACT_LIST_FILTER, type ArtifactListFilter } from './artifact-list-filter'
import { openArtifactInBrowser } from './artifact-link-actions'
import { ArtifactSupersedePicker } from './ArtifactSupersedePicker'
import { SpecPrBatchDialog } from './SpecPrBatchDialog'
import { Button } from '@/components/ui/button'
import { useArtifactLifecycleActions } from './use-artifact-lifecycle-actions'
import { useArtifactSessionLinks } from './use-artifact-session-links'
import { ArtifactsPageSkeleton } from './ArtifactsPageSkeleton'
import {
  ArtifactsPageAuthState,
  ArtifactsPageEmptyState,
  ArtifactsPageErrorBanner
} from './ArtifactsPageStates'
import { artifactAccountIdentity, useArtifactPagination } from './useArtifactPagination'

const LOCAL_RUNTIME = { kind: 'local' } as const
const EMPTY_SLUGS: ReadonlySet<string> = new Set()

export default function ArtifactsPage({
  embedded = false
}: {
  embedded?: boolean
}): React.JSX.Element {
  const keyboardEnabled = usePaneKeyboardEnabled()
  const closePage = useAppStore((state) => state.closeArtifactsPage)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const refreshAuth = useAppStore((state) => state.refreshCurrentOrcaProfileAuth)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const confirm = useConfirmationDialog()
  // Why: publishing is off by default, so "ask your agent to share" is a dead end until the
  // capability is granted. Only claim that once settings have actually loaded.
  const publishingBlocked = settings ? settings.artifactSharingEnabled !== true : false
  const [deleting, setDeleting] = useState<{ identity: string; slug: string } | null>(null)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [filter, setFilter] = useState<ArtifactListFilter>(DEFAULT_ARTIFACT_LIST_FILTER)
  const [groupBySession, setGroupBySession] = useState(false)
  const [checkedSlugs, setCheckedSlugs] = useState<ReadonlySet<string>>(() => new Set())
  const [batchEnabled, setBatchEnabled] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const signedIn = authStatus?.state === 'connected'
  const needsReconnect = authStatus?.state === 'reconnect-required'
  const openAccountSettings = (): void => {
    openSettingsTarget({ pane: 'omni-account', repoId: null })
    openSettingsPage()
  }
  const {
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
  } = useArtifactPagination(authStatus, refreshAuth, filter)
  const sessionLinks = useArtifactSessionLinks(artifacts)
  const loadedChecked = useMemo(
    () =>
      new Set(
        artifacts.map(({ artifact }) => artifact.slug).filter((slug) => checkedSlugs.has(slug))
      ),
    [artifacts, checkedSlugs]
  )
  const batchItems = useMemo(
    () => artifacts.filter((item) => loadedChecked.has(item.artifact.slug)),
    [artifacts, loadedChecked]
  )
  useEffect(() => {
    void callRuntimeRpc<{ enabled: boolean }>(LOCAL_RUNTIME, 'specPrBatch.available', {})
      .then((result) => setBatchEnabled(result.enabled))
      .catch(() => setBatchEnabled(false))
  }, [])
  const lifecycleActions = useArtifactLifecycleActions({
    identity: accountIdentity,
    artifacts,
    replaceArtifact,
    sessionLinks,
    checkedSlugs: loadedChecked,
    clearChecked: () => setCheckedSlugs(new Set()),
    confirm
  })
  const titleForSlug = (slug: string): string | null => {
    const found = artifacts.find(({ artifact }) => artifact.slug === slug)
    return found ? artifactName(found) : null
  }
  const openSuccessor = (slug: string): void => {
    if (artifacts.some(({ artifact }) => artifact.slug === slug)) {
      setSelectedSlug(slug)
      return
    }
    // Why: a successor outside this view still opens, at the same origin as the loaded pages.
    const sample = artifacts[0]?.shareUrl
    if (sample) {
      openArtifactInBrowser(new URL(`/a/${encodeURIComponent(slug)}`, sample).toString())
    }
  }
  const changeFilter = (next: ArtifactListFilter): void => {
    setCheckedSlugs(new Set())
    setFilter(next)
  }
  const drawerLifecycle: ArtifactDrawerLifecycle | undefined = lifecycleSupported
    ? { handlers: lifecycleActions.handlers, sessionLinks, titleForSlug, openSuccessor }
    : undefined
  const collectionLifecycle: ArtifactCollectionLifecycle | undefined = lifecycleSupported
    ? {
        filter,
        onFilterChange: changeFilter,
        groupBySession,
        onGroupBySessionChange: setGroupBySession,
        handlers: lifecycleActions.handlers,
        checkedSlugs: loadedChecked,
        onCheckedChange: setCheckedSlugs,
        sessionLinks,
        openSuccessor
      }
    : undefined
  const deletingId = deleting?.identity === accountIdentity ? deleting.slug : null
  const selectedArtifact =
    selectedSlug === null
      ? null
      : (artifacts.find(({ artifact }) => artifact.slug === selectedSlug) ?? null)

  useEffect(() => {
    if (selectedSlug && !artifacts.some(({ artifact }) => artifact.slug === selectedSlug)) {
      setSelectedSlug(null)
    }
  }, [selectedSlug, artifacts])

  useEffect(() => {
    if (!keyboardEnabled) {
      return
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (target.dataset.escapeClearsValue === 'true') {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      if (selectedSlug) {
        event.preventDefault()
        setSelectedSlug(null)
        return
      }
      if (!embedded) {
        event.preventDefault()
        closePage()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePage, selectedSlug, keyboardEnabled, embedded])

  const deleteArtifact = async (item: ArtifactListItem): Promise<void> => {
    const name = item.artifact.title || item.artifact.originalFileName || item.artifact.slug
    if (!settings?.skipDeleteArtifactConfirm) {
      const accepted = await confirm({
        title: translate('auto.components.artifacts.ArtifactsPage.deleteTitle', 'Delete artifact?'),
        description: translate(
          'auto.components.artifacts.ArtifactsPage.deleteDescription',
          '“{{name}}” will no longer be available at its public link.',
          { name }
        ),
        confirmLabel: translate('auto.components.artifacts.ArtifactsPage.delete', 'Delete'),
        confirmVariant: 'destructive',
        dontAskAgain: {
          onConfirmed: () =>
            persistConfirmationSkipPreference({
              updates: { skipDeleteArtifactConfirm: true },
              settingsSectionId: 'general-skip-delete-artifact-confirm',
              updateSettings,
              openSettingsPage,
              openSettingsTarget
            })
        }
      })
      if (!accepted) {
        return
      }
    }
    const requestedIdentity = accountIdentity
    if (!requestedIdentity) {
      return
    }
    const requestedAccountIsCurrent = (): boolean =>
      artifactAccountIdentity(useAppStore.getState().orcaProfileAuthStatus) === requestedIdentity
    if (!requestedAccountIsCurrent()) {
      return
    }
    setDeleting({ identity: requestedIdentity, slug: item.artifact.slug })
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<void>>(
        LOCAL_RUNTIME,
        'artifacts.delete',
        { id: item.artifact.slug }
      )
      if (!requestedAccountIsCurrent()) {
        return
      }
      if (result.status !== 'ok') {
        await refreshAuth()
        throw new Error(result.status)
      }
      removeArtifact(requestedIdentity, item.artifact.slug)
    } catch (deleteError) {
      console.error('Failed to delete artifact:', deleteError)
      if (requestedAccountIsCurrent()) {
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.deleteFailed',
            'Could not delete the artifact.'
          )
        )
      }
    } finally {
      setDeleting((current) =>
        current?.identity === requestedIdentity && current.slug === item.artifact.slug
          ? null
          : current
      )
    }
  }

  return (
    <main
      className={
        embedded
          ? 'relative flex h-full min-h-0 flex-1 flex-col bg-background text-foreground'
          : 'relative flex h-full min-h-0 flex-1 flex-col bg-background pt-5 text-foreground md:pt-6'
      }
    >
      {!embedded ? (
        <header
          className="flex shrink-0 items-center px-3 pb-3 md:px-5"
          // Why: no stacked center titlebar on this page; keep the title clear of Windows/Linux window controls.
          style={
            {
              paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))'
            } as React.CSSProperties
          }
        >
          <h1 className="truncate text-base font-semibold leading-8">
            {translate('auto.components.artifacts.ArtifactsPage.title', 'Artifacts')}
          </h1>
          {batchEnabled ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setBatchOpen(true)}
            >
              {translate('auto.components.artifacts.ArtifactsPage.specBatches', 'Spec batches')}
            </Button>
          ) : null}
        </header>
      ) : null}

      {error ? (
        <ArtifactsPageErrorBanner
          error={error}
          loading={loading}
          onRetry={() => void loadArtifacts()}
        />
      ) : null}
      {!signedIn ? (
        <ArtifactsPageAuthState
          connecting={connecting}
          needsReconnect={needsReconnect}
          configured={authStatus?.configured === true}
          onConnect={() => void connect()}
          onOpenAccountSettings={openAccountSettings}
        />
      ) : loading && artifacts.length === 0 ? (
        <ArtifactsPageSkeleton />
      ) : artifacts.length === 0 && !lifecycleSupported ? (
        <ArtifactsPageEmptyState
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
          publishingBlocked={publishingBlocked}
          onLoadMore={() => void loadMoreArtifacts()}
          onOpenArtifactsSettings={() => {
            openSettingsTarget({ pane: 'artifacts', repoId: null })
            openSettingsPage()
          }}
        />
      ) : (
        <ArtifactCollection
          lifecycle={collectionLifecycle}
          artifacts={artifacts}
          deletingId={deletingId}
          selectedSlug={selectedSlug}
          selectArtifact={setSelectedSlug}
          deleteArtifact={(target) => void deleteArtifact(target)}
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
          loadMore={() => void loadMoreArtifacts()}
          onRefresh={() => void loadArtifacts()}
          isRefreshing={loading}
        />
      )}

      {lifecycleSupported && signedIn ? (
        <ArtifactBulkBar
          count={loadedChecked.size}
          running={lifecycleActions.bulkRunning || lifecycleActions.undoRunning}
          onAction={lifecycleActions.runBulk}
          onClear={() => setCheckedSlugs(new Set())}
          batchEnabled={batchEnabled}
          onBuildBatch={() => setBatchOpen(true)}
        />
      ) : null}
      {lifecycleSupported ? (
        <ArtifactSupersedePicker
          open={lifecycleActions.picker !== null}
          items={artifacts}
          exclude={
            lifecycleActions.picker?.mode === 'row'
              ? new Set([lifecycleActions.picker.item.artifact.slug])
              : EMPTY_SLUGS
          }
          onPick={lifecycleActions.pickSuccessor}
          onClose={lifecycleActions.closePicker}
        />
      ) : null}

      <ArtifactDetailDrawer
        lifecycle={drawerLifecycle}
        item={selectedArtifact}
        deleting={deletingId === selectedArtifact?.artifact.slug}
        onClose={() => setSelectedSlug(null)}
        onDelete={(target) => void deleteArtifact(target)}
      />
      {batchEnabled ? (
        <SpecPrBatchDialog
          open={batchOpen}
          items={batchItems}
          onClose={() => setBatchOpen(false)}
        />
      ) : null}
    </main>
  )
}
