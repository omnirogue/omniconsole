import type { BrowserWindow } from 'electron'
import { RuntimeClientError } from './runtime-client-error'

type TerminalWindow = Pick<BrowserWindow, 'isFocused' | 'isDestroyed'> & {
  webContents: Pick<BrowserWindow['webContents'], 'executeJavaScript'>
}
type RendererActionOutcome = {
  found?: unknown
  claimed?: unknown
  /** False when the window owns the pane but keyboard focus is in another view. */
  documentFocused?: unknown
  focused?: unknown
  applied?: unknown
}
let terminalWindow: TerminalWindow | null = null

export function registerTerminalAccessibleWindow(window: TerminalWindow): () => void {
  terminalWindow = window
  return () => {
    if (terminalWindow === window) {
      terminalWindow = null
    }
  }
}

/** Deliver through xterm.onData, including the pane's normal local/SSH input guards. */
export async function actOnTerminalAccessibleRenderer(
  paneKey: string,
  value?: string
): Promise<void> {
  const window = terminalWindow
  if (!window || window.isDestroyed() || !window.isFocused()) {
    throw new RuntimeClientError(
      'window_not_focused',
      'Terminal window does not own keyboard focus'
    )
  }
  const payload = JSON.stringify({ paneKey, value })
  const outcome = (await window.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const request = ${payload};
      const inputs = document.querySelectorAll('textarea[data-omni-terminal-pane]');
      const input = Array.from(inputs).find(element => element.dataset.omniTerminalPane === request.paneKey);
      if (!input) return resolve({ found: false });
      // Why reported apart from "not found": the pane IS here, so observing again
      // cannot help — a guest view (browser tab, editor) holds the keyboard.
      if (!document.hasFocus()) return resolve({ found: true, documentFocused: false });
      const event = new CustomEvent('omni-terminal-accessible-action', { detail: request, cancelable: true });
      input.dispatchEvent(event);
      const result = request.result || {};
      resolve({
        found: true,
        claimed: event.defaultPrevented,
        focused: document.activeElement === input,
        applied: result.applied
      });
    }));
  })`)) as RendererActionOutcome | null
  assertRendererActionDelivered(outcome, value)
}

// Why a mapped outcome: the actor must be able to tell a stale element from a pane that
// matched but refused keyboard focus, instead of reading one generic failure for both.
function assertRendererActionDelivered(
  outcome: RendererActionOutcome | null,
  value?: string
): void {
  const result = outcome && typeof outcome === 'object' ? outcome : {}
  if (result.found === true && result.documentFocused === false) {
    throw new RuntimeClientError(
      'window_not_focused',
      'The OmniConsole window owns this pane but the keyboard is in another view, so nothing was delivered; bring the terminal pane forward and retry'
    )
  }
  if (result.found !== true || result.claimed !== true) {
    throw new RuntimeClientError(
      'element_not_found',
      'Terminal input is unavailable or no longer owns this pane; observe the app state again'
    )
  }
  if (result.focused !== true) {
    throw new RuntimeClientError(
      'window_not_focused',
      'Terminal input could not take keyboard focus, so nothing was delivered; reveal the pane and retry'
    )
  }
  if (typeof value === 'string' && value !== '' && result.applied === false) {
    throw new RuntimeClientError(
      'element_not_found',
      'Terminal input took focus but dropped the text; observe the app state again'
    )
  }
}
