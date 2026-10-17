/**
 * Why listbox carries an exemption: the sidebar's workspace and conversation lists are
 * app chrome with `role="listbox"`, mounted for the whole session. Counting them as an
 * overlay made every page think a popup owned Escape, so Escape stopped closing the page
 * itself. `:not()` matches the element, never its subtree, so a real popover or combobox
 * listbox rendered inside the sidebar is still an overlay and still owns Escape.
 */
const PERSISTENT_LIST_ATTRIBUTE = 'data-sidebar-persistent-list'
const OVERLAY_SELECTOR = `[role="dialog"], [role="alertdialog"], [role="listbox"]:not([${PERSISTENT_LIST_ATTRIBUTE}]), [role="menu"]`

type VisibleOverlayOptions = {
  /** Overlays inside a match are treated as page content, not as a layer above it. */
  ignoreSelector?: string
}

/**
 * Whether a dialog, alert dialog, listbox, or menu is on screen. Page-level Escape
 * handlers ask this before acting: the overlay owns the first Escape, and a page
 * that preventDefaults instead vetoes the overlay's own dismissal.
 */
export function hasVisibleOverlay(options?: VisibleOverlayOptions): boolean {
  return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some((element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }
    if (element.closest('[aria-hidden="true"]')) {
      return false
    }
    if (options?.ignoreSelector && element.closest(options.ignoreSelector)) {
      return false
    }
    const style = window.getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    )
  })
}
