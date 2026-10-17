import {
  equalShares,
  sessionGridPaneIds,
  SESSION_GRID_MAX_PER_TRACK,
  type SessionGridLayout,
  type SessionGridOrientation
} from './session-grid-layout'

/** An arrangement: pane counts per track, in columns or rows. */
export type SessionGridPreset = { orientation: SessionGridOrientation; counts: number[] }

export function sessionGridPreset(layout: SessionGridLayout): SessionGridPreset {
  return { orientation: layout.orientation, counts: layout.tracks.map((track) => track.length) }
}

// Why: n columns of one pane each are the same picture as one row of n panes.
function canonicalPreset(preset: SessionGridPreset): string {
  const total = preset.counts.reduce((sum, value) => sum + value, 0)
  if (total === 1) {
    return 'single'
  }
  return preset.counts.length === 1
    ? `${preset.orientation === 'columns' ? 'rows' : 'columns'}:${Array(total).fill(1).join(',')}`
    : `${preset.orientation}:${preset.counts.join(',')}`
}

export function sameSessionGridPreset(left: SessionGridPreset, right: SessionGridPreset): boolean {
  return canonicalPreset(left) === canonicalPreset(right)
}

/** Re-flows the panes, in reading order, into the preset's tracks with equal sizes. */
export function applySessionGridPreset(
  layout: SessionGridLayout,
  preset: SessionGridPreset
): SessionGridLayout {
  const ids = sessionGridPaneIds(layout)
  const tracks: string[][] = []
  let offset = 0
  for (const count of preset.counts) {
    const track = ids.slice(offset, offset + count)
    offset += count
    if (track.length > 0) {
      tracks.push(track)
    }
  }
  if (offset < ids.length && tracks.length > 0) {
    tracks.at(-1)!.push(...ids.slice(offset))
  }
  return {
    orientation: preset.orientation,
    tracks,
    trackSizes: equalShares(tracks.length),
    paneSizes: tracks.map((track) => equalShares(track.length))
  }
}

function compositions(total: number, parts: number, max: number): number[][] {
  if (parts === 1) {
    return total >= 1 && total <= max ? [[total]] : []
  }
  const out: number[][] = []
  for (let first = 1; first <= Math.min(max, total - parts + 1); first += 1) {
    for (const rest of compositions(total - first, parts - 1, max)) {
      out.push([first, ...rest])
    }
  }
  return out
}

function isMonotone(counts: readonly number[]): boolean {
  const rising = counts.every((count, index) => index === 0 || count >= counts[index - 1]!)
  const falling = counts.every((count, index) => index === 0 || count <= counts[index - 1]!)
  return rising || falling
}

const PRESETS_PER_ORIENTATION = 6

/**
 * The arrangements offered for `count` panes: balanced tracks first ("2 | 1", "3 | 2", 2×2 …),
 * each in columns and in rows. One track of n panes is offered as n tracks of one instead.
 */
export function sessionGridPresets(count: number): SessionGridPreset[] {
  if (count <= 0) {
    return []
  }
  if (count === 1) {
    return [{ orientation: 'columns', counts: [1] }]
  }
  const candidates: number[][] = []
  for (let parts = 2; parts <= Math.min(count, SESSION_GRID_MAX_PER_TRACK); parts += 1) {
    for (const counts of compositions(count, parts, SESSION_GRID_MAX_PER_TRACK)) {
      const spread = Math.max(...counts) - Math.min(...counts)
      if (spread <= 2 && isMonotone(counts)) {
        candidates.push(counts)
      }
    }
  }
  const ranked = candidates
    .map((counts) => ({ counts, spread: Math.max(...counts) - Math.min(...counts) }))
    .sort((left, right) => left.spread - right.spread || left.counts.length - right.counts.length)
    .slice(0, PRESETS_PER_ORIENTATION)
    .map(({ counts }) => counts)
  return (['columns', 'rows'] as const).flatMap((orientation) =>
    ranked.map((counts) => ({ orientation, counts }))
  )
}
