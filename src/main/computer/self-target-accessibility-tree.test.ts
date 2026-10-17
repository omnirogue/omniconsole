import { describe, expect, it } from 'vitest'
import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import {
  assertSelfTargetAccessibilityTree,
  selfTargetAccessibilityTreeMissing
} from './self-target-accessibility-tree'

const CHROME_ONLY_TREE = [
  'App=com.omniconsole.ide (pid 50372)',
  'Window: "Orca", App: OmniConsole.',
  '',
  '0 window Orca',
  '  1 container',
  '  2 close button',
  '  3 minimize button',
  '  4 zoom button',
  '',
  'No UI element is currently focused.'
].join('\n')

function snapshotResult(treeText: string, elementCount: number): ComputerSnapshotResult {
  return {
    snapshot: {
      id: 'snapshot',
      app: { name: 'OmniConsole', bundleId: 'com.omniconsole.ide', pid: 50372 },
      window: { title: 'Orca', width: 1200, height: 800 },
      coordinateSpace: 'window',
      treeText,
      elementCount,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

describe('self-target accessibility tree', () => {
  it('treats a window-chrome-only tree as unavailable', () => {
    expect(
      selfTargetAccessibilityTreeMissing({ treeText: CHROME_ONLY_TREE, elementCount: 5 })
    ).toBe(true)
  })

  it('accepts a tree that carries the renderer web area', () => {
    const tree = `${CHROME_ONLY_TREE}\n  5 html content Orca`

    expect(selfTargetAccessibilityTreeMissing({ treeText: tree, elementCount: 6 })).toBe(false)
  })

  it('reads a localized web-area role, however small the tree', () => {
    // The sidecar renders AXWebArea with the OS-localized role description, so the
    // English role text is not what a German mac reports.
    expect(
      selfTargetAccessibilityTreeMissing({
        treeText: `${CHROME_ONLY_TREE}\n  5 HTML-Inhalt Orca`,
        elementCount: 6
      })
    ).toBe(false)
  })

  it('reads any node that is not window chrome as the app being there', () => {
    expect(
      selfTargetAccessibilityTreeMissing({
        treeText: `${CHROME_ONLY_TREE}\n  5 radio group Sidebar view`,
        elementCount: 6
      })
    ).toBe(false)
  })

  it('does not call a chrome-only tree usable just because it is big', () => {
    // The old count floor called any tree of 16+ nodes usable, web area or not.
    const chromeRows = Array.from({ length: 40 }, (_, index) => `  ${index} container`).join('\n')

    expect(
      selfTargetAccessibilityTreeMissing({
        treeText: `0 standard window Orca\n${chromeRows}`,
        elementCount: 41
      })
    ).toBe(true)
  })

  it('falls back to the element count only when there is no tree to read', () => {
    expect(selfTargetAccessibilityTreeMissing({ treeText: '', elementCount: 440 })).toBe(false)
    expect(selfTargetAccessibilityTreeMissing({ treeText: '', elementCount: 16 })).toBe(false)
    expect(selfTargetAccessibilityTreeMissing({ treeText: '', elementCount: 15 })).toBe(true)
  })

  it('fails loudly instead of returning a chrome-only success', () => {
    expect(() => assertSelfTargetAccessibilityTree(snapshotResult(CHROME_ONLY_TREE, 5))).toThrow(
      expect.objectContaining({
        code: 'accessibility_tree_unavailable',
        message: expect.stringContaining('5 accessibility elements')
      })
    )
  })

  it('does not claim an enable that never happened', () => {
    expect(() =>
      assertSelfTargetAccessibilityTree(snapshotResult(CHROME_ONLY_TREE, 5), {
        accessibilityEnabled: false
      })
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('could not be enabled for this request')
      })
    )
  })

  it('passes a usable tree through', () => {
    expect(() =>
      assertSelfTargetAccessibilityTree(
        snapshotResult(`${CHROME_ONLY_TREE}\n  5 HTML Content Orca`, 440)
      )
    ).not.toThrow()
  })
})
