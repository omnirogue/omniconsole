import { shell } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'

/** One page cannot turn a loop of window.open or location changes into a flood of browser tabs. */
const EXTERNAL_OPEN_MIN_INTERVAL_MS = 1_000

type GuestPolicyTarget = Pick<Electron.WebContents, 'setWindowOpenHandler' | 'on' | 'off'>

/**
 * The preview shows one artifact document and nothing else. Links, form posts and popups the page
 * starts go to the system browser, where the person is signed in to OmniConsole and can act on a
 * review; the preview itself never navigates away. In-page anchors do not fire `will-navigate`,
 * so tables of contents keep working. Subframes (embedded videos, charts) load as in a browser.
 */
export function installArtifactPreviewGuestPolicy(
  guest: GuestPolicyTarget,
  openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
  now: () => number = Date.now
): () => void {
  let lastOpenedAt = -Infinity
  const routeToBrowser = (rawUrl: string): void => {
    const url = normalizeExternalBrowserUrl(rawUrl)
    if (!url || !/^https?:\/\//i.test(url)) {
      return
    }
    const at = now()
    if (at - lastOpenedAt < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
      return
    }
    lastOpenedAt = at
    void openExternal(url).catch(() => {})
  }
  const onWillNavigate = (event: Electron.Event, url: string): void => {
    event.preventDefault()
    routeToBrowser(url)
  }
  guest.setWindowOpenHandler(({ url }) => {
    routeToBrowser(url)
    return { action: 'deny' }
  })
  guest.on('will-navigate', onWillNavigate)
  return () => {
    guest.off('will-navigate', onWillNavigate)
  }
}
