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
// Why: a busy guest must not hold back the new revision for long.
const SCROLL_READ_TIMEOUT_MS = 1_000

type ScrollOffset = { x: number; y: number }

function schedulePreviewTimeout(onTimeout: () => void): () => void {
  const timeout = setTimeout(onTimeout, PREVIEW_LOAD_TIMEOUT_MS)
  return () => clearTimeout(timeout)
}

async function readScrollOffset(webview: Electron.WebviewTag): Promise<ScrollOffset | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result: unknown = await Promise.race([
      webview.executeJavaScript('[window.scrollX, window.scrollY]'),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SCROLL_READ_TIMEOUT_MS)
      })
    ])
    // Why validate: the page controls this value and it is written back into a script.
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !result.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return null
    }
    const [x, y] = result as number[]
    return { x, y }
  } catch {
    // The guest may not have reached dom-ready; reload without restoring.
    return null
  } finally {
    clearTimeout(timeout)
  }
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
  const reloadForRevisionRef = useRef<(() => void) | null>(null)
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
    const webview = createPreviewWebview(contentUrl)
    let cancelLoadTimeout: (() => void) | null = null
    let failed = false
    let disposed = false
    // Why: only a document already on screen reloads in place; a first load keeps its overlay.
    let shown = false
    let inPlaceReload = false
    let restoreOffset: ScrollOffset | null = null
    const clearLoadTimeout = (): void => {
      cancelLoadTimeout?.()
      cancelLoadTimeout = null
    }
    const onLoadStarted = (): void => {
      failed = false
      if (!inPlaceReload) {
        setState('loading')
      }
      clearLoadTimeout()
      cancelLoadTimeout = schedulePreviewTimeout(() => {
        failed = true
        shown = false
        inPlaceReload = false
        setState('unavailable')
      })
    }
    const onLoadStopped = (): void => {
      clearLoadTimeout()
      inPlaceReload = false
      const offset = restoreOffset
      restoreOffset = null
      if (failed) {
        return
      }
      shown = true
      setState('ready')
      if (offset) {
        void webview.executeJavaScript(`window.scrollTo(${offset.x}, ${offset.y})`).catch(() => {})
      }
    }
    const onLoadFailed = (event: Electron.DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === ERR_ABORTED) {
        return
      }
      clearLoadTimeout()
      failed = true
      shown = false
      inPlaceReload = false
      setState('unavailable')
    }
    const onTitleUpdated = (event: Electron.PageTitleUpdatedEvent): void => {
      const title = event.title.trim()
      if (title) {
        onTitleRef.current?.(title)
      }
    }
    const reload = (): void => {
      try {
        // Why ignoring cache: the URL is unchanged across revisions; only the document is new.
        webview.reloadIgnoringCache()
      } catch {
        // A guest that has not reached dom-ready yet is still loading the newest document.
        inPlaceReload = false
        restoreOffset = null
      }
    }
    const reloadForRevision = (): void => {
      if (!shown) {
        reload()
        return
      }
      inPlaceReload = true
      void readScrollOffset(webview).then((offset) => {
        if (disposed) {
          return
        }
        // Why recheck: the document may have failed or a quicker reload finished meanwhile.
        inPlaceReload = shown
        restoreOffset = offset ?? restoreOffset
        reload()
      })
    }
    webview.addEventListener('page-title-updated', onTitleUpdated)
    webview.addEventListener('did-start-loading', onLoadStarted)
    webview.addEventListener('did-stop-loading', onLoadStopped)
    webview.addEventListener('did-fail-load', onLoadFailed)
    onLoadStarted()
    container.appendChild(webview)
    reloadForRevisionRef.current = reloadForRevision
    loadedRevisionRef.current = null
    return () => {
      disposed = true
      clearLoadTimeout()
      reloadForRevisionRef.current = null
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
    reloadForRevisionRef.current?.()
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
