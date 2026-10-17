import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { BrowserWorkspace as BrowserWorkspaceState } from '../../../../../shared/browser-workspace-types'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import { useBrowserAutomationVisiblePageIds } from '../host-guest/browser-automation-visibility'
import { getBrowserPagesForWorkspace } from './browser-pane-page-selection'
import { BrowserMobileDriverOverlay } from './BrowserMobileDriverOverlay'
import {
  IDLE_BROWSER_DRIVER,
  useBrowserDriverForPage,
  useBrowserMobileDrivenPageIds
} from '@/lib/pane-manager/browser-mobile-driver-state'
import { useBrowserRemotelyViewedPageIds } from '@/lib/pane-manager/browser-remote-viewer-state'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { getBrowserPageRuntimeEnvironmentId } from '../describe-page/browser-page-url-display'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { RemoteBrowserPagePane } from '../stream-remote/remote-browser-page-pane'
import { ClientHostedBrowserPagePane } from '../ClientHostedBrowserPagePane'
import { BrowserPagePane } from './browser-page-pane'
import { WorkspaceDocPagePane } from '../workspace-doc/workspace-doc-page-pane'
import { SshRoutedBrowserPageGate } from './ssh-routed-browser-page-gate'

export default function BrowserPane({
  browserTab,
  isActive,
  chromeShortcutScope
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
  chromeShortcutScope?: BrowserChromeShortcutScope
}): React.JSX.Element {
  const resolvedChromeShortcutScope = chromeShortcutScope ?? (isActive ? 'focused' : 'inactive')
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, browserTab.worktreeId)
  )
  const browserPages = useAppStore((s) =>
    getBrowserPagesForWorkspace(s.browserPagesByWorkspace, browserTab.id)
  )
  const activeBrowserPage =
    browserPages.find((page) => page.id === browserTab.activePageId) ?? browserPages[0] ?? null
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const activeBrowserRuntimeEnvironmentId = activeBrowserPage
    ? getBrowserPageRuntimeEnvironmentId(activeBrowserPage, activeRuntimeEnvironmentId)
    : null
  const runtimeEnvironmentActive = Boolean(activeBrowserRuntimeEnvironmentId)
  const activeBrowserPageId = activeBrowserPage?.id ?? null
  const remotePageHandles = useAppStore((state) => state.remoteBrowserPageHandlesByPageId)
  const browserPageIds = useMemo(() => browserPages.map((page) => page.id), [browserPages])
  const automationVisiblePageIds = useBrowserAutomationVisiblePageIds(browserPageIds)
  const mobileDrivenPageIds = useBrowserMobileDrivenPageIds(browserPageIds)
  const remotelyViewedPageIds = useBrowserRemotelyViewedPageIds(browserPageIds)
  // Why: inactive webviews must stay mounted in their original DOM parent; unmounting/reparenting loses form text and SPA state.
  const renderedBrowserPages = useMemo(
    () =>
      browserPages.filter(
        (page) => !getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
      ),
    [browserPages, activeRuntimeEnvironmentId]
  )
  const renderedBrowserPageIds = useMemo(
    () => renderedBrowserPages.map((page) => page.id),
    [renderedBrowserPages]
  )
  const pageDriver = useBrowserDriverForPage(activeBrowserPageId)
  // Why: a runtime-backed page is streamed, never locally driven, so its driver must read idle.
  const activeBrowserDriver = runtimeEnvironmentActive ? IDLE_BROWSER_DRIVER : pageDriver

  useEffect(() => {
    if (!runtimeEnvironmentActive) {
      return
    }
    for (const page of browserPages) {
      if (getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)) {
        destroyPersistentWebview(page.id)
      }
    }
  }, [activeRuntimeEnvironmentId, browserPages, runtimeEnvironmentActive])

  useContextualTour(
    'browser',
    isActive && activeBrowserPage !== null && !runtimeEnvironmentActive,
    'browser_visible'
  )

  const reclaimActiveBrowserForDesktop = useCallback(async (): Promise<void> => {
    if (!activeBrowserPageId) {
      return
    }
    const { reclaimed } = await window.api.runtime.reclaimBrowserForDesktop(activeBrowserPageId)
    if (!reclaimed) {
      throw new Error('Could not reclaim browser control')
    }
  }, [activeBrowserPageId])

  const runtimePages = browserPages.map((page) => {
    const environmentId = getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
    const selected = page.id === activeBrowserPageId
    const automationVisible = automationVisiblePageIds.has(page.id)
    if (!environmentId || (!selected && !automationVisible)) {
      return null
    }
    const handle = remotePageHandles[page.id]
    const environmentHandle = handle?.environmentId === environmentId ? handle : null
    const placement =
      environmentHandle?.placement?.kind === 'client' ? environmentHandle.placement : null
    // Staged/restored client pages retain their component and key through adoption.
    const clientHosted =
      placement ||
      (environmentHandle?.staged === true && environmentHandle.stagedClientHosted === true) ||
      environmentHandle?.restoredClientHosted === true
    if (!clientHosted && !selected) {
      return null
    }
    const visible = isActive && selected
    const scope = selected ? resolvedChromeShortcutScope : 'inactive'
    return (
      <div
        key={`${environmentId}:${page.id}`}
        className="absolute inset-0 flex min-h-0 flex-col"
        inert={!visible}
        aria-hidden={!visible}
        style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
      >
        {clientHosted ? (
          <ClientHostedBrowserPagePane
            browserTab={page}
            workspaceId={browserTab.id}
            runtimeEnvironmentId={environmentId}
            worktreeId={browserTab.worktreeId}
            placement={placement}
            isActive={visible}
            isAutomationVisible={automationVisible}
            chromeShortcutScope={scope}
            onUpdatePageState={updateBrowserPageState}
            onSetUrl={setBrowserPageUrl}
          />
        ) : (
          <RemoteBrowserPagePane
            browserTab={page}
            workspaceId={browserTab.id}
            runtimeEnvironmentId={environmentId}
            worktreeId={browserTab.worktreeId}
            isActive={visible}
            chromeShortcutScope={scope}
            onUpdatePageState={updateBrowserPageState}
            onSetUrl={setBrowserPageUrl}
          />
        )}
      </div>
    )
  })

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {runtimePages}
      {!activeBrowserRuntimeEnvironmentId && renderedBrowserPages.length > 0 ? (
        <SshRoutedBrowserPageGate
          worktreeId={browserTab.worktreeId}
          sessionProfileId={browserTab.sessionProfileId ?? null}
          pageIds={renderedBrowserPageIds}
        >
          {(routedPartition) => (
            <div className="relative flex min-h-0 flex-1">
              {renderedBrowserPages.map((page) =>
                page.docLocation ? (
                  <WorkspaceDocPagePane
                    key={page.id}
                    page={page}
                    isActive={isActive && page.id === activeBrowserPage?.id}
                  />
                ) : (
                  <BrowserPagePane
                    key={page.id}
                    browserTab={page}
                    workspaceId={browserTab.id}
                    worktreeId={browserTab.worktreeId}
                    sessionProfileId={browserTab.sessionProfileId ?? null}
                    sessionPartition={routedPartition ?? browserTab.sessionPartition ?? null}
                    isActive={isActive && page.id === activeBrowserPage?.id}
                    chromeShortcutScope={
                      page.id === activeBrowserPage?.id ? resolvedChromeShortcutScope : 'inactive'
                    }
                    isAutomationVisible={automationVisiblePageIds.has(page.id)}
                    isMobileDriven={mobileDrivenPageIds.has(page.id)}
                    isRemotelyViewed={remotelyViewedPageIds.has(page.id)}
                    inputLocked={activeBrowserDriver.kind === 'mobile'}
                    onUpdatePageState={updateBrowserPageState}
                    onSetUrl={setBrowserPageUrl}
                  />
                )
              )}
              <BrowserMobileDriverOverlay
                driver={activeBrowserDriver}
                onTakeBack={reclaimActiveBrowserForDesktop}
              />
            </div>
          )}
        </SshRoutedBrowserPageGate>
      ) : null}
    </div>
  )
}
