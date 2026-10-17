import type { SessionGridLayout } from './session-grid-layout'

/** A box in fractions of the grid (0–1). */
export type SessionGridBox = { left: number; top: number; width: number; height: number }

export type SessionGridDivider =
  | { kind: 'track'; index: number; box: SessionGridBox; axis: 'x' | 'y' }
  | { kind: 'pane'; track: number; index: number; box: SessionGridBox; axis: 'x' | 'y' }

function starts(shares: readonly number[]): number[] {
  let offset = 0
  return shares.map((share) => {
    const start = offset
    offset += share
    return start
  })
}

/**
 * Every pane's box and every divider, from the layout. Why absolute boxes and not nested flex:
 * a pane keeps one parent however the grid is rearranged, so a borrowed terminal or webview is
 * never remounted (a webview reloads when its DOM parent changes).
 */
export function sessionGridGeometry(layout: SessionGridLayout): {
  panes: Map<string, SessionGridBox>
  dividers: SessionGridDivider[]
} {
  const columns = layout.orientation === 'columns'
  const panes = new Map<string, SessionGridBox>()
  const dividers: SessionGridDivider[] = []
  const trackStarts = starts(layout.trackSizes)
  layout.tracks.forEach((track, trackIndex) => {
    const trackStart = trackStarts[trackIndex]!
    const trackShare = layout.trackSizes[trackIndex]!
    const paneShares = layout.paneSizes[trackIndex] ?? []
    const paneStarts = starts(paneShares)
    track.forEach((paneId, paneIndex) => {
      const start = paneStarts[paneIndex]!
      const share = paneShares[paneIndex]!
      panes.set(
        paneId,
        columns
          ? { left: trackStart, top: start, width: trackShare, height: share }
          : { left: start, top: trackStart, width: share, height: trackShare }
      )
      if (paneIndex > 0) {
        dividers.push({
          kind: 'pane',
          track: trackIndex,
          index: paneIndex - 1,
          axis: columns ? 'y' : 'x',
          box: columns
            ? { left: trackStart, top: start, width: trackShare, height: 0 }
            : { left: start, top: trackStart, width: 0, height: trackShare }
        })
      }
    })
    if (trackIndex > 0) {
      dividers.push({
        kind: 'track',
        index: trackIndex - 1,
        axis: columns ? 'x' : 'y',
        box: columns
          ? { left: trackStart, top: 0, width: 0, height: 1 }
          : { left: 0, top: trackStart, width: 1, height: 0 }
      })
    }
  })
  return { panes, dividers }
}

/** The pointer's position along a divider's axis, as the share the divider's first side becomes. */
export function sessionGridDividerShare(args: {
  divider: SessionGridDivider
  layout: SessionGridLayout
  pointer: { x: number; y: number }
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
}): number {
  const { divider, layout, pointer, rect } = args
  const fraction =
    divider.axis === 'x'
      ? (pointer.x - rect.left) / Math.max(1, rect.width)
      : (pointer.y - rect.top) / Math.max(1, rect.height)
  if (divider.kind === 'track') {
    const before = layout.trackSizes.slice(0, divider.index).reduce((sum, share) => sum + share, 0)
    return fraction - before
  }
  // Why no track offset: a track spans the whole grid along its own panes' axis.
  const shares = layout.paneSizes[divider.track] ?? []
  const before = shares.slice(0, divider.index).reduce((sum, share) => sum + share, 0)
  return fraction - before
}
