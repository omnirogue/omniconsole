export type BrowserCleanupMode = 'unused' | 'all'

export type BrowserCleanupRequest =
  | { action: 'preview'; mode: BrowserCleanupMode }
  | { action: 'apply'; token: string }

export type BrowserCleanupRow = {
  pageId: string
  workspaceId: string
  worktreeId: string
  profileId: string | null
  title: string
  url: string
  eligible: boolean
  reason: string
  outcome?: 'closed' | 'kept' | 'unconfirmed'
}

export type BrowserCleanupReport = {
  token: string
  mode: BrowserCleanupMode
  expiresAt: number
  rows: BrowserCleanupRow[]
  reopenPath?: string
}

export type BrowserCleanupIpcRequest = BrowserCleanupRequest & { requestId: string }
export type BrowserCleanupIpcReply = {
  requestId: string
  report?: BrowserCleanupReport
  error?: string
}

// No form values or page text cross the inspection boundary.
export const BROWSER_CLEANUP_INSPECTION = `(() => {
  function inspect(root) {
    if (root.querySelector('[contenteditable]:not([contenteditable="false"])')) return 'Editable content';
    if (root.querySelector('iframe, frame, object, embed')) return 'Embedded content cannot be checked';
    for (const field of root.querySelectorAll('input, textarea, select')) {
      if (field.tagName === 'SELECT') {
        if ([...field.options].some(o => o.selected !== o.defaultSelected)) return 'Changed form';
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked !== field.defaultChecked) return 'Changed form';
      } else if (field.type !== 'hidden' && field.type !== 'submit' && field.type !== 'button') {
        if (field.value || field.value !== field.defaultValue) return 'Form content';
      }
    }
    for (const media of root.querySelectorAll('audio, video')) {
      if (!media.paused || media.srcObject) return 'Active media';
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        const reason = inspect(element.shadowRoot);
        if (reason) return reason;
      }
    }
    return null;
  }
  if (document.readyState !== 'complete') return 'Page is loading';
  if (window.onbeforeunload) return 'Page has a leave-page warning';
  return inspect(document);
})()`

export type BrowserCleanupGuestRequest = { pageId: string; guestId: number; url: string }
export type BrowserCleanupGuestResult = 'closed' | 'kept' | 'unconfirmed'
