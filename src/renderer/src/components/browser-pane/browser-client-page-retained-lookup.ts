import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser-client-page-renderer-protocol'
import type {
  BrowserClientRetainedRendererPage,
  BrowserClientRetainedViewport
} from './browser-client-page-retained-state'

type PageIdentity = Pick<BrowserClientPageRendererIdentity, 'browserPageId' | 'pageHostGeneration'>

export function findRetainedPage(
  pages: Map<string, BrowserClientRetainedRendererPage>,
  identity: PageIdentity
): BrowserClientRetainedRendererPage | undefined {
  return [...pages.values()].find(
    (page) =>
      page.identity.browserPageId === identity.browserPageId &&
      page.identity.pageHostGeneration === identity.pageHostGeneration
  )
}

export function readRetainedViewport(
  pages: Map<string, BrowserClientRetainedRendererPage>,
  identity: PageIdentity
): BrowserClientRetainedViewport | null {
  const page = findRetainedPage(pages, identity)
  return page
    ? {
        identity: page.identity,
        status: page.status,
        webContentsId: page.webContentsId,
        webview: page.webview,
        host: page.host,
        container: page.visibleAttachment?.container ?? null
      }
    : null
}
