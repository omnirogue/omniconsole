import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { usePaneFocus } from '@/components/pane-focus-context'
import {
  useOpenInPane,
  useOpenInPaneHandler,
  type OpenInPane
} from '@/components/open-in-pane-context'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { openHttpLink } from '@/lib/http-link-routing'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { buildBrowserPage } from '@/store/slices/browser-page-records'
import { resolveBackofficeBaseUrl } from '../../../../shared/backoffice-connection'
import { normalizeExternalBrowserUrl } from '../../../../shared/browser-url'
import { BrowserPagePane } from '../browser-pane/assemble-chrome/browser-page-pane'
import { claimBrowserOverlaySlotViewport } from '../browser-pane/host-guest/browser-page-viewport'
import { destroyPersistentWebview } from '../browser-pane/host-guest/webview-registry'
import type { BrowserTabPageState } from '../browser-pane/describe-page/browser-page-types'
import { useOmniOSDocumentStatus, type OmniOSDocumentStatus } from './use-omnios-document-status'

export const OMNIOS_DECISIONS_VIEW_ID = 'omnios-decisions'
export const OMNIOS_DECISIONS_PARTITION = 'persist:omni-browser'

export function OmniOSDecisionsPane({
  url,
  onOpenInNewPane
}: {
  url?: string
  onOpenInNewPane?: OpenInPane
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  if (settings?.commandCenter !== true) {
    return null
  }
  const connection = resolveBackofficeBaseUrl(settings)
  if (!connection.configured) {
    return (
      <p role="status" className="p-3 text-sm">
        {connection.message}
      </p>
    )
  }
  return (
    <DecisionsBrowser
      key={connection.baseUrl}
      baseUrl={connection.baseUrl}
      initialUrl={url}
      onOpenInNewPane={onOpenInNewPane}
    />
  )
}

function DecisionsBrowser({
  baseUrl,
  initialUrl,
  onOpenInNewPane
}: {
  baseUrl: string
  initialUrl?: string
  onOpenInNewPane?: OpenInPane
}): React.JSX.Element {
  const [page, setPage] = useState(() => {
    const id = `decisions:${crypto.randomUUID()}`
    return buildBrowserPage(
      id,
      id,
      initialUrl && isDecisionUrl(initialUrl, baseUrl) ? initialUrl : `${baseUrl}/work/decisions`
    )
  })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [documentStatus, setDocumentStatus] = useState<OmniOSDocumentStatus>('loading')
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const mounted = useRef(false)
  const releaseSlot = useRef<(() => void) | null>(null)
  const pane = usePaneFocus()
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  const visible = pane.visible && windowVisible
  const claimRoot = useCallback(
    (node: HTMLDivElement | null) => {
      releaseSlot.current?.()
      releaseSlot.current = node ? claimBrowserOverlaySlotViewport(page.workspaceId, node) : null
      setRoot(node)
    },
    [page.workspaceId]
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // StrictMode remounts the same owner before this microtask runs.
      queueMicrotask(() => {
        if (!mounted.current) {
          void destroyPersistentWebview(page.id)
        }
      })
    }
  }, [page.id])
  const navigate = useCallback((url: string) => {
    const normalized = normalizeExternalBrowserUrl(url)
    if (normalized) {
      setDocumentStatus('loading')
      setPage((previous) => ({ ...previous, url: normalized, loadError: null, loading: true }))
    }
  }, [])
  const [previousInitialUrl, setPreviousInitialUrl] = useState(initialUrl)
  if (initialUrl !== previousInitialUrl) {
    setPreviousInitialUrl(initialUrl)
    navigate(
      initialUrl && isDecisionUrl(initialUrl, baseUrl) ? initialUrl : `${baseUrl}/work/decisions`
    )
  }
  const openDecision = useOpenInPane(navigate)
  useEffect(
    () =>
      window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url }) => {
        if (browserPageId !== page.id) {
          return
        }
        // Decision details keep the current guest and sign-in, including target=_blank links.
        if (isDecisionUrl(url, baseUrl)) {
          navigate(url)
        } else {
          openDecision(url)
        }
      }),
    [page.id, baseUrl, navigate, openDecision]
  )
  const updatePage = useCallback((_id: string, updates: BrowserTabPageState) => {
    setPage((previous) => ({ ...previous, ...updates }))
  }, [])
  const commitUrl = useCallback((_id: string, url: string) => {
    const normalized = normalizeExternalBrowserUrl(url)
    if (normalized) {
      setPage((previous) => ({ ...previous, url: normalized }))
    }
  }, [])
  const reportStatus = useCallback((status: OmniOSDocumentStatus) => {
    setDocumentStatus(status)
    if (status === 'ready') {
      setLastSuccessAt(Date.now())
    }
  }, [])
  useOmniOSDocumentStatus(root, baseUrl, reportStatus)
  const openArtifactsPage = useAppStore((state) => state.openArtifactsPage)
  const openWorkHomePage = useAppStore((state) => state.openWorkHomePage)
  const provider = useOpenInPaneHandler()
  const openNewPane = onOpenInNewPane ?? provider
  const failed = page.loadError !== null || documentStatus === 'unavailable'
  const status = failed ? (lastSuccessAt === null ? 'unavailable' : 'stale') : documentStatus
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      data-pane-view-id={OMNIOS_DECISIONS_VIEW_ID}
      data-decisions-status={status}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
          {status === 'signed-out' || (status === 'loading' && lastSuccessAt === null)
            ? translate('commandCenter.decisions.signIn', 'Sign in to OmniOS')
            : status === 'unavailable' || status === 'stale'
              ? translate(
                  'commandCenter.decisions.unavailable',
                  'OmniOS Decisions could not be loaded.'
                )
              : status === 'loading'
                ? translate('work.loading', 'Loading…')
                : translate('commandCenter.decisions.title', 'OmniOS Decisions')}
          {status === 'stale' && lastSuccessAt !== null ? (
            <>
              {' '}
              {translate(
                'commandCenter.decisions.stale',
                'Last loaded at {{time}}. Reload to refresh.',
                { time: new Date(lastSuccessAt).toLocaleTimeString() }
              )}
            </>
          ) : null}
        </div>
        <Button size="xs" variant="ghost" onClick={() => navigate(`${baseUrl}/work/decisions`)}>
          {translate('commandCenter.decisions.home', 'Decisions')}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => openArtifactsPage?.()}>
          {translate('commandCenter.decisions.artifacts', 'Artifacts')}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => openWorkHomePage?.()}>
          {translate('commandCenter.decisions.workHome', 'Work home')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={translate('commandCenter.decisions.actions', 'Decision page actions')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {openNewPane ? (
              <DropdownMenuItem onClick={() => openNewPane(page.url)}>
                {translate('commandCenter.openInNewPane', 'Open in new pane')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => openHttpLink(page.url, { forceSystemBrowser: true })}>
              {translate('commandCenter.openInBrowser', 'Open in browser')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={claimRoot} className="absolute inset-0" />
        {root ? (
          <BrowserPagePane
            browserTab={page}
            workspaceId={page.workspaceId}
            worktreeId={page.worktreeId}
            sessionProfileId={null}
            sessionPartition={OMNIOS_DECISIONS_PARTITION}
            isActive={visible}
            chromeShortcutScope={visible && pane.focused ? 'focused' : 'inactive'}
            isAutomationVisible={false}
            isMobileDriven={false}
            isRemotelyViewed={false}
            inputLocked={!visible}
            onUpdatePageState={updatePage}
            onSetUrl={commitUrl}
            embedded
          />
        ) : null}
      </div>
    </section>
  )
}

export function isDecisionUrl(url: string, baseUrl: string): boolean {
  try {
    const target = new URL(url)
    const base = new URL(baseUrl)
    const path = `${base.pathname.replace(/\/$/, '')}/work/decisions`
    return (
      target.origin === base.origin &&
      (target.pathname === path || target.pathname.startsWith(`${path}/`))
    )
  } catch {
    return false
  }
}
