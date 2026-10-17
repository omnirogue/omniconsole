const pagesByLease = new Map<string, string>()
let userFocus: HTMLElement | null = null

function rememberUserFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !active.closest('[inert]')) {
    userFocus = active
  }
}

export function acquireBrowserAutomationFocus(token: string, browserPageId: string): void {
  if (typeof document === 'undefined') {
    return
  }
  if (pagesByLease.size === 0) {
    rememberUserFocus()
    document.addEventListener('focusin', rememberUserFocus, true)
  }
  pagesByLease.set(token, browserPageId)
}

export function releaseBrowserAutomationFocus(token: string): void {
  const browserPageId = pagesByLease.get(token)
  if (!browserPageId) {
    return
  }
  pagesByLease.delete(token)
  try {
    const host = document.activeElement?.closest<HTMLElement>('[data-browser-client-page-id]')
    // Native guest input can focus an inert host; restore only that background takeover.
    if (
      host?.getAttribute('data-browser-client-page-id') === browserPageId &&
      host.hasAttribute('inert') &&
      userFocus?.isConnected &&
      !userFocus.closest('[inert]')
    ) {
      try {
        userFocus.focus({ preventScroll: true })
      } catch {
        // A retired guest must not prevent the visibility lease from releasing.
      }
    }
  } finally {
    if (pagesByLease.size === 0) {
      document.removeEventListener('focusin', rememberUserFocus, true)
      userFocus = null
    }
  }
}
