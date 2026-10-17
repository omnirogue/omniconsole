import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser-client-page-renderer-protocol'

type RetainedAttachmentOwner = { container: HTMLElement; interactive: boolean }

export type BrowserClientRetainedRendererPage = {
  key: string
  identity: BrowserClientPageRendererIdentity
  host: HTMLDivElement
  webview: Electron.WebviewTag
  status: 'attaching' | 'attached' | 'retiring'
  webContentsId: number | null
  metadataRevision: number
  attachmentObserved: boolean
  visibleAttachment: {
    container: HTMLElement
    interactive: boolean
    owners: Set<RetainedAttachmentOwner>
    stopTracking: (() => void) | null
  } | null
  mount: Promise<{ webContentsId: number }>
  resolveMount: (value: { webContentsId: number }) => void
  rejectMount: (error: Error) => void
  attachTimer: ReturnType<typeof setTimeout>
  onAttached: EventListener
  onReady: EventListener
  onDestroyed: EventListener
  onRendererGone: EventListener
  releaseDragPassthroughSurface: () => void
}

export type BrowserClientRetainedViewport = Readonly<
  Pick<
    BrowserClientRetainedRendererPage,
    'identity' | 'status' | 'webContentsId' | 'host' | 'webview'
  > & {
    container: HTMLElement | null
  }
>
