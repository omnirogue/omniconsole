import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import { RuntimeClientError } from './runtime-client-error'

// Why: Electron publishes the renderer accessibility tree only to a detected assistive
// client, so a self-targeted snapshot can "succeed" carrying window chrome alone —
// window, container, close/zoom/minimize — with nothing in the app to target.
//
// The reading is by ROLE, not by size: the tree is usable the moment it carries the web
// area, or ANY node that is not window chrome. A count floor used to stand in for a
// localized web-area role description, and it cut both ways — it called a 16-node
// chrome-only tree usable, and a small tree in German ("HTML-Inhalt") unusable.
const WEB_CONTENT_ROLE_LINE =
  /^[ \t]*\d+ +(html content|web content|web area|html-inhalt|webbereich|contenu html|zone web|contenido html|área web|contenuto html)\b/i
// Every role macOS/Windows window chrome is made of. Anything else is the app's own UI.
const CHROME_ROLE_LINE =
  /^[ \t]*\d+ +(standard window|dialog|window|container|group|toolbar|title bar|menu bar|grow area|close button|minimize button|zoom button|full screen button|fullscreen button)\b/i
// A row in the rendered tree: "<index> <role> [name]".
const TREE_ROLE_ROW = /^[ \t]*\d+ +\S/
// Why a floor at all, still: a snapshot can carry a count with no readable tree text
// (a truncated or non-rendering sidecar payload), and a real renderer tree is hundreds
// of nodes, never five.
const RENDERER_TREE_ELEMENT_FLOOR = 16

export function selfTargetAccessibilityTreeMissing(snapshot: {
  treeText?: string | null
  elementCount?: number | null
}): boolean {
  const treeText = typeof snapshot.treeText === 'string' ? snapshot.treeText : ''
  const rows = treeText.split('\n').filter((line) => TREE_ROLE_ROW.test(line))
  if (!rows.length) {
    return (snapshot.elementCount ?? 0) < RENDERER_TREE_ELEMENT_FLOOR
  }
  return !rows.some((line) => WEB_CONTENT_ROLE_LINE.test(line) || !CHROME_ROLE_LINE.test(line))
}

/** Fail loudly instead of returning a chrome-only tree as a usable observation. */
export function assertSelfTargetAccessibilityTree(
  result: ComputerSnapshotResult,
  // Why the caller decides: the refusal must not claim an enable that never ran.
  options: { accessibilityEnabled?: boolean } = {}
): void {
  const snapshot = result?.snapshot
  if (!snapshot || !selfTargetAccessibilityTreeMissing(snapshot)) {
    return
  }
  const remedy =
    options.accessibilityEnabled === false
      ? 'accessibility support could not be enabled for this request because no OmniConsole window is registered, so open the app window and retry'
      : 'accessibility support was enabled for this request, so retry get-app-state once, and if the tree is still window chrome only check the Accessibility permission and that the window has a loaded renderer'
  throw new RuntimeClientError(
    'accessibility_tree_unavailable',
    `OmniConsole returned ${snapshot.elementCount ?? 0} accessibility elements with no renderer web area, so nothing inside the app window can be targeted; ${remedy}`
  )
}
