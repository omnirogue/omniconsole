import { useLayoutEffect, useRef } from 'react'

export const PANE_HEADER_ACTION_GUTTER = '--pane-header-action-gutter'

/** The work rail shares this container with the overlay; reserve only actions that intersect a header row. */
export function usePaneHeaderActionGutter() {
  const overlayRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    const shell = overlay?.parentElement
    if (!overlay || !shell) {
      return
    }
    return trackPaneHeaderActions(overlay, shell)
  })
  return overlayRef
}

function trackPaneHeaderActions(overlay: HTMLElement, shell: HTMLElement): () => void {
  const reserved = new Set<HTMLElement>()
  const measure = () => {
    const actions = Array.from(overlay.querySelectorAll<HTMLElement>('.pane-title-actions'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
    for (const row of shell.querySelectorAll<HTMLElement>('[data-conversation-header-row]')) {
      const rect = row.getBoundingClientRect()
      const gutter = actions.reduce((width, action) => {
        if (
          action.bottom <= rect.top ||
          action.top >= rect.bottom ||
          action.right <= rect.left ||
          action.left >= rect.right
        ) {
          return width
        }
        return Math.max(width, rect.right - action.left)
      }, 0)
      if (gutter > 0) {
        row.style.setProperty(PANE_HEADER_ACTION_GUTTER, `${Math.ceil(gutter)}px`)
        reserved.add(row)
      } else {
        row.style.removeProperty(PANE_HEADER_ACTION_GUTTER)
        reserved.delete(row)
      }
    }
  }
  // Why a frame gate: the shell also holds the live terminal, whose output mutates the DOM
  // continuously; measuring at most once per frame keeps layout reads off that hot path.
  let frame = 0
  const scheduleMeasure = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
  }
  const resize = new ResizeObserver(scheduleMeasure)
  const refreshMeasurements = () => {
    resize.disconnect()
    resize.observe(shell)
    resize.observe(overlay)
    for (const element of shell.querySelectorAll<HTMLElement>(
      '[data-conversation-header-row], .pane-title-bar, .pane-title-actions'
    )) {
      resize.observe(element)
    }
    scheduleMeasure()
  }
  let pendingRefresh = 0
  const mutations = new MutationObserver(() => {
    if (pendingRefresh === 0) {
      pendingRefresh = requestAnimationFrame(() => {
        pendingRefresh = 0
        refreshMeasurements()
      })
    }
  })
  mutations.observe(shell, { childList: true, subtree: true })
  refreshMeasurements()
  measure()
  return () => {
    cancelAnimationFrame(frame)
    cancelAnimationFrame(pendingRefresh)
    resize.disconnect()
    mutations.disconnect()
    for (const row of reserved) {
      row.style.removeProperty(PANE_HEADER_ACTION_GUTTER)
    }
  }
}
