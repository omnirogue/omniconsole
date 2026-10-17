import type { Terminal } from '@xterm/xterm'
import {
  decodeTerminalAccessiblePaneToken,
  terminalAccessiblePaneLabelSuffix
} from '../../../../shared/terminal-accessible-pane-token'

/** Fallback name when xterm has not labelled its input yet; the identity must still be stamped. */
const FALLBACK_INPUT_LABEL = 'Terminal input'

/** Keep xterm's localized input label while making kept-alive panes distinguishable. */
export function installTerminalAccessibleIdentity(
  terminal: Pick<Terminal, 'textarea' | 'focus' | 'input'>,
  paneKey: string
): { dispose: () => void } {
  const textarea = terminal.textarea
  if (!textarea) {
    return { dispose: () => {} }
  }
  const suffix = terminalAccessiblePaneLabelSuffix(paneKey)
  const update = (): void => {
    const label = textarea.getAttribute('aria-label')
    if (!label) {
      textarea.setAttribute('aria-label', FALLBACK_INPUT_LABEL + suffix)
      return
    }
    if (!label.endsWith(suffix)) {
      textarea.setAttribute('aria-label', label + suffix)
    }
  }
  textarea.dataset.omniTerminalPane = paneKey
  const action = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !addressesThisPane(event.detail, paneKey)) {
      return
    }
    // Claim the request first: the caller distinguishes "wrong pane" from "focus refused".
    event.preventDefault()
    terminal.focus()
    const focused = document.activeElement === textarea
    const value = typeof event.detail.value === 'string' ? event.detail.value : ''
    if (focused && value) {
      terminal.input(value, true)
    }
    if (event.detail && typeof event.detail === 'object') {
      event.detail.result = { focused, applied: focused && value !== '' }
    }
  }
  textarea.addEventListener('omni-terminal-accessible-action', action)
  update()
  const observer = new MutationObserver(update)
  observer.observe(textarea, { attributes: true, attributeFilter: ['aria-label'] })
  return {
    dispose: () => {
      observer.disconnect()
      textarea.removeEventListener('omni-terminal-accessible-action', action)
      delete textarea.dataset.omniTerminalPane
    }
  }
}

// Why both forms: the paneKey is percent-encoded inside the accessibility name, so a caller
// that read it from there must match the same pane as one holding the raw key.
function addressesThisPane(detail: unknown, paneKey: string): boolean {
  const requested = (detail as { paneKey?: unknown } | null)?.paneKey
  if (typeof requested !== 'string') {
    return false
  }
  return requested === paneKey || decodeTerminalAccessiblePaneToken(requested) === paneKey
}
