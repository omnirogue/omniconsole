import { describe, expect, it } from 'vitest'
import {
  chatDropZoneToSplitDirection,
  resolveChatDropZone,
  type ChatDropZoneRect
} from './chat-drop-zone'

const RECT: ChatDropZoneRect = { left: 100, top: 200, width: 400, height: 300 }
// Edge band is 30% of size: x in [100,220] or [380,500] is edge; y in [200,290] or [470,500] is edge.

function zoneAt(clientX: number, clientY: number): string {
  return resolveChatDropZone({ clientX, clientY, rect: RECT })
}

describe('resolveChatDropZone', () => {
  it('resolves the exact center to center', () => {
    expect(zoneAt(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2)).toBe('center')
  })

  it('resolves a point well inside the middle band to center', () => {
    expect(zoneAt(250, 300)).toBe('center')
  })

  it('resolves the left edge band (mid-height) to left', () => {
    expect(zoneAt(110, RECT.top + RECT.height / 2)).toBe('left')
  })

  it('resolves the right edge band (mid-height) to right', () => {
    expect(zoneAt(490, RECT.top + RECT.height / 2)).toBe('right')
  })

  it('resolves the top edge band (mid-width) to top', () => {
    expect(zoneAt(RECT.left + RECT.width / 2, 210)).toBe('top')
  })

  it('resolves the bottom edge band (mid-width) to bottom', () => {
    expect(zoneAt(RECT.left + RECT.width / 2, 480)).toBe('bottom')
  })

  it('breaks a top-left corner tie (equal distance to left and top edges) toward horizontal', () => {
    // localX = 5 (distance to left edge 5), localY = 5 (distance to top edge 5) -> tie -> horizontal wins
    expect(zoneAt(105, 205)).toBe('left')
  })

  it('breaks a bottom-right corner tie (equal distance to right and bottom edges) toward horizontal', () => {
    // localX = 395 -> distance to right = 5; localY = 295 -> distance to bottom = 5 -> tie -> horizontal wins
    expect(zoneAt(495, 495)).toBe('right')
  })

  it('picks the vertical edge in a corner when strictly closer to the top edge', () => {
    // localX = 50 -> distance to left = 50; localY = 2 -> distance to top = 2 -> vertical wins
    expect(zoneAt(150, 202)).toBe('top')
  })

  it('picks the vertical edge in a corner when strictly closer to the bottom edge', () => {
    // localX = 350 -> distance to right = 50; localY = 298 -> distance to bottom = 2 -> vertical wins
    expect(zoneAt(450, 498)).toBe('bottom')
  })

  it('treats the left boundary pixel (exactly at the edge band) as center', () => {
    // localX = edgeX = 120 exactly -> inclusive of center per spec
    expect(zoneAt(220, RECT.top + RECT.height / 2)).toBe('center')
  })

  it('treats one pixel inside the left boundary as left', () => {
    expect(zoneAt(219, RECT.top + RECT.height / 2)).toBe('left')
  })

  it('treats the right boundary pixel (exactly at the edge band) as center', () => {
    // localX = width - edgeX = 280 -> clientX = 380
    expect(zoneAt(380, RECT.top + RECT.height / 2)).toBe('center')
  })

  it('treats one pixel inside the right boundary as right', () => {
    expect(zoneAt(381, RECT.top + RECT.height / 2)).toBe('right')
  })

  it('treats the top boundary pixel (exactly at the edge band) as center', () => {
    // localY = edgeY = 90 -> clientY = 290
    expect(zoneAt(RECT.left + RECT.width / 2, 290)).toBe('center')
  })

  it('treats one pixel inside the top boundary as top', () => {
    expect(zoneAt(RECT.left + RECT.width / 2, 289)).toBe('top')
  })

  it('treats the bottom boundary pixel (exactly at the edge band) as center', () => {
    // localY = height - edgeY = 210 -> clientY = 410
    expect(zoneAt(RECT.left + RECT.width / 2, 410)).toBe('center')
  })

  it('treats one pixel inside the bottom boundary as bottom', () => {
    expect(zoneAt(RECT.left + RECT.width / 2, 411)).toBe('bottom')
  })

  it('clamps a pointer far outside the rect to the nearest edge zone', () => {
    expect(zoneAt(-1000, RECT.top + RECT.height / 2)).toBe('left')
    expect(zoneAt(10000, RECT.top + RECT.height / 2)).toBe('right')
  })

  it('falls back to center for a degenerate zero-size rect', () => {
    expect(
      resolveChatDropZone({
        clientX: 5,
        clientY: 5,
        rect: { left: 0, top: 0, width: 0, height: 0 }
      })
    ).toBe('center')
  })

  it('falls back to center for a negative-size rect', () => {
    expect(
      resolveChatDropZone({
        clientX: 5,
        clientY: 5,
        rect: { left: 0, top: 0, width: -10, height: 20 }
      })
    ).toBe('center')
  })
})

describe('chatDropZoneToSplitDirection', () => {
  it('maps top to up and bottom to down (tab-group split naming)', () => {
    expect(chatDropZoneToSplitDirection('top')).toBe('up')
    expect(chatDropZoneToSplitDirection('bottom')).toBe('down')
  })

  it('passes left/right through unchanged', () => {
    expect(chatDropZoneToSplitDirection('left')).toBe('left')
    expect(chatDropZoneToSplitDirection('right')).toBe('right')
  })

  it('returns undefined for center (no split)', () => {
    expect(chatDropZoneToSplitDirection('center')).toBeUndefined()
  })
})
