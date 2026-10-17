import { describe, expect, it } from 'vitest'
import { sessionGridDividerShare, sessionGridGeometry } from './session-grid-geometry'
import type { SessionGridLayout } from './session-grid-layout'

const threeTwo: SessionGridLayout = {
  orientation: 'columns',
  tracks: [
    ['a', 'b', 'c'],
    ['d', 'e']
  ],
  trackSizes: [0.6, 0.4],
  paneSizes: [
    [0.5, 0.25, 0.25],
    [0.5, 0.5]
  ]
}

describe('session grid geometry', () => {
  it('places three panes on the left and two on the right', () => {
    const { panes } = sessionGridGeometry(threeTwo)
    expect(panes.get('a')).toEqual({ left: 0, top: 0, width: 0.6, height: 0.5 })
    expect(panes.get('c')).toEqual({ left: 0, top: 0.75, width: 0.6, height: 0.25 })
    expect(panes.get('e')).toEqual({ left: 0.6, top: 0.5, width: 0.4, height: 0.5 })
  })

  it('draws one divider between the columns and one between each stacked pair', () => {
    const { dividers } = sessionGridGeometry(threeTwo)
    expect(dividers.filter((divider) => divider.kind === 'track')).toHaveLength(1)
    expect(dividers.filter((divider) => divider.kind === 'pane')).toHaveLength(3)
  })

  it('lays rows out on the other axis', () => {
    const { panes } = sessionGridGeometry({ ...threeTwo, orientation: 'rows' })
    expect(panes.get('d')).toEqual({ left: 0, top: 0.6, width: 0.5, height: 0.4 })
  })

  it('turns the pointer into the share of the side before the divider', () => {
    const { dividers } = sessionGridGeometry(threeTwo)
    const rect = { left: 100, top: 0, width: 1000, height: 500 }
    const column = dividers.find((divider) => divider.kind === 'track')!
    expect(
      sessionGridDividerShare({
        divider: column,
        layout: threeTwo,
        pointer: { x: 400, y: 0 },
        rect
      })
    ).toBeCloseTo(0.3)
    const lower = dividers.find((divider) => divider.kind === 'pane' && divider.index === 1)!
    // Between b and c: the pointer at 90% down leaves b 40% of the column after a's 50%.
    expect(
      sessionGridDividerShare({ divider: lower, layout: threeTwo, pointer: { x: 0, y: 450 }, rect })
    ).toBeCloseTo(0.4)
  })
})
