import { describe, expect, it } from 'vitest'
import { appendSessionGridPane, emptySessionGridLayout } from './session-grid-layout'
import {
  applySessionGridPreset,
  sameSessionGridPreset,
  sessionGridPreset,
  sessionGridPresets
} from './session-grid-presets'

const counts = (count: number, orientation: 'columns' | 'rows') =>
  sessionGridPresets(count)
    .filter((preset) => preset.orientation === orientation)
    .map((preset) => preset.counts.join('|'))

describe('session grid presets', () => {
  it('offers "2 on one side, 1 on the other" both ways for three panes', () => {
    expect(counts(3, 'columns')).toEqual(expect.arrayContaining(['2|1', '1|2', '1|1|1']))
    expect(counts(3, 'rows')).toEqual(expect.arrayContaining(['2|1', '1|2', '1|1|1']))
  })

  it('offers "3 on one side, 2 on the other" for five panes', () => {
    expect(counts(5, 'columns')).toEqual(expect.arrayContaining(['3|2', '2|3']))
  })

  it('never offers more than four panes in one track', () => {
    for (let count = 1; count <= 8; count += 1) {
      for (const preset of sessionGridPresets(count)) {
        expect(Math.max(...preset.counts)).toBeLessThanOrEqual(4)
        expect(preset.counts.reduce((sum, value) => sum + value, 0)).toBe(count)
      }
    }
  })

  it('re-flows the panes in reading order with equal sizes', () => {
    const layout = ['a', 'b', 'c', 'd', 'e'].reduce(
      (current, id) => appendSessionGridPane(current, id),
      emptySessionGridLayout()
    )
    // Appending built [[a, d], [b, c], [e]]; reading order runs down each column in turn.
    const applied = applySessionGridPreset(layout, { orientation: 'columns', counts: [3, 2] })
    expect(applied.tracks).toEqual([
      ['a', 'd', 'b'],
      ['c', 'e']
    ])
    expect(applied.trackSizes).toEqual([0.5, 0.5])
    expect(sessionGridPreset(applied)).toEqual({ orientation: 'columns', counts: [3, 2] })
  })

  it('treats one column of three as three rows of one', () => {
    expect(
      sameSessionGridPreset(
        { orientation: 'columns', counts: [3] },
        { orientation: 'rows', counts: [1, 1, 1] }
      )
    ).toBe(true)
    expect(
      sameSessionGridPreset(
        { orientation: 'columns', counts: [2, 1] },
        { orientation: 'rows', counts: [2, 1] }
      )
    ).toBe(false)
  })
})
