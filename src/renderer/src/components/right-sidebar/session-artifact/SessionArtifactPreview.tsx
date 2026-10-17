import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { ARTIFACT_PREVIEW_PARTITION } from '../../../../../shared/artifact-session'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser-guest-web-preferences'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import { translate } from '@/i18n/i18n'

type PreviewState = 'loading' | 'ready' | 'unavailable'
const PREVIEW_LOAD_TIMEOUT_MS = 20_000
// Why: Chromium reports an aborted load (a reload superseding the previous one) as -3.
const ERR_ABORTED = -3

function schedulePreviewTimeout(onTimeout: () => void): () => void {
  const timeout = setTimeout(onTimeout, PREVIEW_LOAD_TIMEOUT_MS)
  return () => clearTimeout(timeout)
}

/**
 * Why a webview on its own partition, not an iframe in this renderer: the artifact's scripts get a
 * separate, sandboxed process with no preload, no Node and no access to the app's origin or
 * storage. The main process admits only this partition + an artifact document URL, attaches the
 * bearer to that one request, and sends every link or popup to the system browser. The renderer
 * only ever holds the URL.
 */
function createPreviewWebview(contentUrl: string): Electron.WebviewTag {
  const webview = document.createElement('webview') as Electron.WebviewTag
  webview.setAttribute('partition', ARTIFACT_PREVIEW_PARTITION)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute(
    'aria-label',
    translate('auto.components.artifacts.preview', 'Artifact preview')
  )
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.setAttribute('src', contentUrl)
  return webview
}

export function SessionArtifactPreview({
  contentUrl,
  revision,
  onTitle
}: {
  contentUrl: string
  /** A change reloads the page; null until the server has answered. */
  revision: number | null
  /** The page's own document title, once it has one. */
  onTitle?: (title: string) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onTitleRef = useRef(onTitle)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const loadedRevisionRef = useRef<number | null>(null)
  const [state, setState] = useState<PreviewState>('loading')

  useLayoutEffect(() => {
    onTitleRef.current = onTitle
  }, [onTitle])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    let cancelLoadTimeout: (() => void) | null = null
    let failed = false
    const clearLoadTimeout = (): void => {
      cancelLoadTimeout?.()
      cancelLoadTimeout = null
    }
    const onLoadStarted = (): void => {
      failed = false
      setState('loading')
      clearLoadTimeout()
      cancelLoadTimeout = schedulePreviewTimeout(() => {
        failed = true
        setState('unavailable')
      })
    }
    const onLoadStopped = (): void => {
      clearLoadTimeout()
      if (!failed) {
        setState('ready')
      }
    }
    const onLoadFailed = (event: Electron.DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === ERR_ABORTED) {
        return
      }
      clearLoadTimeout()
      failed = true
      setState('unavailable')
    }
    const onTitleUpdated = (event: Electron.PageTitleUpdatedEvent): void => {
      const title = event.title.trim()
      if (title) {
        onTitleRef.current?.(title)
      }
    }
    const webview = createPreviewWebview(contentUrl)
    webview.addEventListener('page-title-updated', onTitleUpdated)
    webview.addEventListener('did-start-loading', onLoadStarted)
    webview.addEventListener('did-stop-loading', onLoadStopped)
    webview.addEventListener('did-fail-load', onLoadFailed)
    onLoadStarted()
    container.appendChild(webview)
    webviewRef.current = webview
    loadedRevisionRef.current = null
    return () => {
      clearLoadTimeout()
      webviewRef.current = null
      webview.removeEventListener('page-title-updated', onTitleUpdated)
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
    }
  }, [contentUrl])

  useEffect(() => {
    if (revision === null) {
      return
    }
    const previous = loadedRevisionRef.current
    loadedRevisionRef.current = revision
    if (previous === null || previous === revision) {
      return
    }
    try {
      // Why ignoring cache: the URL is unchanged across revisions; only the document is new.
      webviewRef.current?.reloadIgnoringCache()
    } catch {
      // A guest that has not reached dom-ready yet is still loading the newest document.
    }
    // Why contentUrl too: a new artifact resets the baseline even when its revision number matches.
  }, [contentUrl, revision])

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background" ref={containerRef}>
      {state === 'loading' ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {state === 'unavailable' ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background px-6 text-center">
          <AlertCircle className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">
            {translate('auto.components.artifacts.previewUnavailable', 'Preview unavailable')}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {translate(
              'auto.components.artifacts.previewUnavailableDescription',
              'Open this artifact in your browser to view it.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
