/**
 * Pure geometry for "drag a chat onto the workspace" drops (#simple-work-0912).
 *
 * Dropping a session-sidebar row onto a pane decides where the new split goes
 * purely from pointer position against the target pane's rect. Kept separate
 * from `tab-group/tab-drop-zone.ts` (which drives tab-bar-internal drags with
 * its own thresholds) so each drag channel can tune its own edge bands
 * without one drag type's UX change silently moving the other's.
 */

export type ChatDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type ChatDropZoneRect = {
  left: number
  top: number
  width: number
  height: number
}

/** Fraction of the pane's width/height, from each edge, treated as a split band. */
export const CHAT_DROP_ZONE_EDGE_BAND = 0.3

/**
 * Resolves which region of `rect` the pointer at (`clientX`, `clientY`) is
 * over: an outer edge band on each side (`left`/`right`/`top`/`bottom`), or
 * `center` for everything inside those bands. Boundary pixels count as the
 * inner ('center') side of the band, so the center region is a closed
 * [edge, size - edge] interval.
 *
 * When outside an edge band on both axes (a corner), the zone is whichever
 * edge the pointer is numerically closer to — ties go to the horizontal
 * (left/right) zone, matching how split-heavy layouts (two or four panes)
 * bias toward side-by-side columns before rows.
 */
export function resolveChatDropZone(args: {
  clientX: number
  clientY: number
  rect: ChatDropZoneRect
}): ChatDropZone {
  const { clientX, clientY, rect } = args
  if (rect.width <= 0 || rect.height <= 0) {
    return 'center'
  }

  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const edgeX = rect.width * CHAT_DROP_ZONE_EDGE_BAND
  const edgeY = rect.height * CHAT_DROP_ZONE_EDGE_BAND

  const inHorizontalCenter = localX >= edgeX && localX <= rect.width - edgeX
  const inVerticalCenter = localY >= edgeY && localY <= rect.height - edgeY
  if (inHorizontalCenter && inVerticalCenter) {
    return 'center'
  }

  // Why: distance-to-edge, not just "which half", so a corner picks the edge
  // it actually overhangs rather than always defaulting to top/bottom.
  const distanceToLeft = localX
  const distanceToRight = rect.width - localX
  const distanceToTop = localY
  const distanceToBottom = rect.height - localY

  const horizontalDistance = Math.min(distanceToLeft, distanceToRight)
  const verticalDistance = Math.min(distanceToTop, distanceToBottom)

  if (horizontalDistance <= verticalDistance) {
    return distanceToLeft <= distanceToRight ? 'left' : 'right'
  }
  return distanceToTop <= distanceToBottom ? 'top' : 'bottom'
}

/** Split direction to hand to the tab-group split API (`TabSplitDirection`); `undefined` for `center` (no split, just add/move into the group). */
export function chatDropZoneToSplitDirection(
  zone: ChatDropZone
): 'left' | 'right' | 'up' | 'down' | undefined {
  switch (zone) {
    case 'top':
      return 'up'
    case 'bottom':
      return 'down'
    case 'left':
      return 'left'
    case 'right':
      return 'right'
    case 'center':
      return undefined
  }
}
