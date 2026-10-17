import { useEffect } from 'react'

export type OmniOSDocumentStatus = 'loading' | 'signed-out' | 'ready' | 'unavailable'
const PREFIX = 'omni-decisions-document-status:'

// Only presentation state crosses this boundary; never identity, cookies or page data.
export const OMNIOS_DOCUMENT_STATUS_SCRIPT = `(() => {
  window.__omniDecisionsStatusObserver?.disconnect();
  let previous;
  const report = () => {
    const status = document.querySelector('.cl-signIn-root, .cl-signUp-root') ? 'signed-out'
      : document.querySelector('[data-testid="auth-error"]') ? 'unavailable'
      : document.querySelector('[data-testid="auth-loading-clerk"], [data-testid="auth-exchanging"]')
        || !(document.getElementById('root') ?? document.body)?.firstElementChild ? 'loading' : 'ready';
    if (status !== previous) { previous = status; console.info('${PREFIX}' + status); }
  };
  window.__omniDecisionsStatusObserver = new MutationObserver(report);
  window.__omniDecisionsStatusObserver.observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-testid']});
  report();
})()`

export function parseOmniOSDocumentStatus(message: string): OmniOSDocumentStatus | null {
  if (!message.startsWith(PREFIX)) {
    return null
  }
  const status = message.slice(PREFIX.length)
  return status === 'loading' ||
    status === 'signed-out' ||
    status === 'ready' ||
    status === 'unavailable'
    ? status
    : null
}

function observeGuestStatus(
  guest: Electron.WebviewTag,
  baseUrl: string,
  onStatus: (status: OmniOSDocumentStatus) => void
): () => void {
  const trusted = () => {
    try {
      return new URL(guest.getURL()).origin === new URL(baseUrl).origin
    } catch {
      return false
    }
  }
  const install = () => {
    if (trusted()) {
      void guest.executeJavaScript(OMNIOS_DOCUMENT_STATUS_SCRIPT).catch(() => {})
    }
  }
  const receive = (event: Electron.ConsoleMessageEvent) => {
    const status = parseOmniOSDocumentStatus(event.message)
    if (status && trusted()) {
      onStatus(status)
    }
  }
  guest.addEventListener('dom-ready', install)
  guest.addEventListener('console-message', receive)
  install()
  return () => {
    guest.removeEventListener('dom-ready', install)
    guest.removeEventListener('console-message', receive)
  }
}

export function useOmniOSDocumentStatus(
  root: HTMLDivElement | null,
  baseUrl: string,
  onStatus: (status: OmniOSDocumentStatus) => void
): void {
  useEffect(() => {
    if (!root) {
      return
    }
    let disposeGuest: (() => void) | undefined
    let guest: Electron.WebviewTag | null = null
    const attach = () => {
      const next = root.querySelector('webview') as Electron.WebviewTag | null
      if (next === guest) {
        return
      }
      disposeGuest?.()
      guest = next
      disposeGuest = next ? observeGuestStatus(next, baseUrl, onStatus) : undefined
    }
    const observer = new MutationObserver(attach)
    observer.observe(root, { childList: true, subtree: true })
    attach()
    return () => {
      observer.disconnect()
      disposeGuest?.()
    }
  }, [root, baseUrl, onStatus])
}
