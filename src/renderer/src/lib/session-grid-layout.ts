/**
 * Pure geometry for the Grid view: up to eight panes in tracks — columns left to right, each
 * stacked top to bottom, or rows top to bottom, each laid out left to right. "3 on one side, 2
 * on the other" is `{ orientation: 'columns', tracks: [[a, b, c], [d, e]] }`.
 */

export const SESSION_GRID_MAX_PANES = 8
export const SESSION_GRID_MAX_PER_TRACK = 4
/** The smallest share of its container a track or pane can be resized to. */
export const SESSION_GRID_MIN_SHARE = 0.1

export type SessionGridOrientation = 'columns' | 'rows'
export type SessionGridDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type SessionGridLayout = {
  orientation: SessionGridOrientation
  /** Pane ids per track, in reading order. */
  tracks: string[][]
  /** Each track's share of the grid; sums to 1. */
  trackSizes: number[]
  /** Each pane's share of its track; each track's sums to 1. */
  paneSizes: number[][]
}

export function emptySessionGridLayout(
  orientation: SessionGridOrientation = 'columns'
): SessionGridLayout {
  return { orientation, tracks: [], trackSizes: [], paneSizes: [] }
}

export function sessionGridPaneIds(layout: SessionGridLayout): string[] {
  return layout.tracks.flat()
}

export function equalShares(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

/** Shares scaled to sum to 1; a wrong length or a bad value falls back to equal shares. */
export function normalizeShares(shares: readonly number[] | undefined, count: number): number[] {
  if (
    !shares ||
    shares.length !== count ||
    shares.some((share) => !Number.isFinite(share) || share <= 0)
  ) {
    return equalShares(count)
  }
  const total = shares.reduce((sum, share) => sum + share, 0)
  return shares.map((share) => share / total)
}

/** Drops empty tracks and repairs sizes, so every layout read from storage is usable. */
export function normalizeSessionGridLayout(layout: SessionGridLayout): SessionGridLayout {
  const kept = layout.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.length > 0)
  const trackSizes = normalizeShares(
    kept.length === layout.tracks.length ? layout.trackSizes : undefined,
    kept.length
  )
  return {
    orientation: layout.orientation === 'rows' ? 'rows' : 'columns',
    tracks: kept.map(({ track }) => [...track]),
    trackSizes,
    paneSizes: kept.map(({ track, index }) =>
      normalizeShares(layout.paneSizes[index], track.length)
    )
  }
}

function locate(layout: SessionGridLayout, paneId: string): { track: number; pane: number } | null {
  for (let track = 0; track < layout.tracks.length; track += 1) {
    const pane = layout.tracks[track]!.indexOf(paneId)
    if (pane !== -1) {
      return { track, pane }
    }
  }
  return null
}

/** Splits `shares[index]` in two, the new half placed before or after it. */
function splitShare(shares: readonly number[], index: number, after: boolean): number[] {
  const half = shares[index]! / 2
  const next = [...shares]
  next.splice(index, 1, half)
  next.splice(after ? index + 1 : index, 0, half)
  return next
}

/** Removes `shares[index]`, handing its share to the rest in proportion. */
function dropShare(shares: readonly number[], index: number): number[] {
  const rest = shares.filter((_, position) => position !== index)
  return normalizeShares(rest, rest.length)
}

// Tracks a grid of `count` panes opens with: 2 → side by side, 4 → 2×2, 8 → 4×2.
const DEFAULT_TRACK_COUNT = [1, 1, 2, 2, 2, 3, 3, 4, 4]

/** Adds a pane where a new one naturally goes: a new track while there are few, else the emptiest. */
export function appendSessionGridPane(
  layout: SessionGridLayout,
  paneId: string
): SessionGridLayout {
  const count = sessionGridPaneIds(layout).length + 1
  if (layout.tracks.length < (DEFAULT_TRACK_COUNT[count] ?? 4)) {
    const trackCount = layout.tracks.length + 1
    return {
      ...layout,
      tracks: [...layout.tracks, [paneId]],
      trackSizes: [
        ...layout.trackSizes.map((share) => (share * (trackCount - 1)) / trackCount),
        1 / trackCount
      ],
      paneSizes: [...layout.paneSizes, [1]]
    }
  }
  let target = 0
  layout.tracks.forEach((track, index) => {
    if (track.length <= layout.tracks[target]!.length) {
      target = index
    }
  })
  const size = layout.tracks[target]!.length + 1
  return {
    ...layout,
    tracks: layout.tracks.map((track, index) => (index === target ? [...track, paneId] : track)),
    paneSizes: layout.paneSizes.map((shares, index) =>
      index === target ? [...shares.map((share) => (share * (size - 1)) / size), 1 / size] : shares
    )
  }
}

/** Whether `zone` opens a new track (across) or joins the target's track (along). */
function zonePlacement(
  orientation: SessionGridOrientation,
  zone: Exclude<SessionGridDropZone, 'center'>
): { across: boolean; after: boolean } {
  const horizontal = zone === 'left' || zone === 'right'
  return {
    across: orientation === 'columns' ? horizontal : !horizontal,
    after: zone === 'right' || zone === 'bottom'
  }
}

/** Places a pane beside `target` on the side the pointer chose; 'center' appends. */
export function insertSessionGridPane(
  layout: SessionGridLayout,
  paneId: string,
  target: { paneId: string; zone: SessionGridDropZone } | null
): SessionGridLayout {
  const at = target ? locate(layout, target.paneId) : null
  if (!target || !at || target.zone === 'center') {
    return appendSessionGridPane(layout, paneId)
  }
  const { across, after } = zonePlacement(layout.orientation, target.zone)
  if (across) {
    const index = after ? at.track + 1 : at.track
    const tracks = [...layout.tracks]
    tracks.splice(index, 0, [paneId])
    const paneSizes = [...layout.paneSizes]
    paneSizes.splice(index, 0, [1])
    return {
      ...layout,
      tracks,
      trackSizes: splitShare(layout.trackSizes, at.track, after),
      paneSizes
    }
  }
  return {
    ...layout,
    tracks: layout.tracks.map((track, index) => {
      if (index !== at.track) {
        return track
      }
      const next = [...track]
      next.splice(after ? at.pane + 1 : at.pane, 0, paneId)
      return next
    }),
    paneSizes: layout.paneSizes.map((shares, index) =>
      index === at.track ? splitShare(shares, at.pane, after) : shares
    )
  }
}

export function removeSessionGridPane(
  layout: SessionGridLayout,
  paneId: string
): SessionGridLayout {
  const at = locate(layout, paneId)
  if (!at) {
    return layout
  }
  if (layout.tracks[at.track]!.length === 1) {
    return {
      ...layout,
      tracks: layout.tracks.filter((_, index) => index !== at.track),
      trackSizes: dropShare(layout.trackSizes, at.track),
      paneSizes: layout.paneSizes.filter((_, index) => index !== at.track)
    }
  }
  return {
    ...layout,
    tracks: layout.tracks.map((track, index) =>
      index === at.track ? track.filter((id) => id !== paneId) : track
    ),
    paneSizes: layout.paneSizes.map((shares, index) =>
      index === at.track ? dropShare(shares, at.pane) : shares
    )
  }
}

/** Puts `nextId` where `paneId` was, keeping its size. */
export function replaceSessionGridPane(
  layout: SessionGridLayout,
  paneId: string,
  nextId: string
): SessionGridLayout {
  return {
    ...layout,
    tracks: layout.tracks.map((track) => track.map((id) => (id === paneId ? nextId : id)))
  }
}

/** Drags a pane onto another: the middle swaps the two, an edge moves it beside the target. */
export function moveSessionGridPane(
  layout: SessionGridLayout,
  paneId: string,
  target: { paneId: string; zone: SessionGridDropZone }
): SessionGridLayout {
  if (paneId === target.paneId || !locate(layout, paneId) || !locate(layout, target.paneId)) {
    return layout
  }
  if (target.zone === 'center') {
    return {
      ...layout,
      tracks: layout.tracks.map((track) =>
        track.map((id) => (id === paneId ? target.paneId : id === target.paneId ? paneId : id))
      )
    }
  }
  return insertSessionGridPane(removeSessionGridPane(layout, paneId), paneId, target)
}

/**
 * Moves the divider after `shares[index]` so that share becomes `share`, taking the difference
 * from its neighbour; both stay at least SESSION_GRID_MIN_SHARE of the pair's total.
 */
export function resizeSessionGridShares(
  shares: readonly number[],
  index: number,
  share: number
): number[] {
  if (index < 0 || index >= shares.length - 1 || !Number.isFinite(share)) {
    return [...shares]
  }
  const pair = shares[index]! + shares[index + 1]!
  const floor = Math.min(SESSION_GRID_MIN_SHARE, pair / 2)
  const clamped = Math.min(pair - floor, Math.max(floor, share))
  const next = [...shares]
  next[index] = clamped
  next[index + 1] = pair - clamped
  return next
}
