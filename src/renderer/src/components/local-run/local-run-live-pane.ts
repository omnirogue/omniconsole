import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import type { TerminalHandleTarget } from '../terminal-pane/terminal-handle-links'

/** Slot the canvas lends to one running node's live terminal. */
export const LOCAL_RUN_PANE_SLOT_ID = 'local-run-node-pane'

/**
 * The live pane of a running node is the worker's own TerminalPane, portaled out of
 * the hidden workbench into the canvas — never a second PTY and never a copy of its
 * output. An unresolved handle publishes nothing, so the slot stays empty rather than
 * showing whichever terminal happened to be active.
 */
export function localRunPanePortalDescriptors(args: {
  handle: string | null
  target: TerminalHandleTarget | null
  element: HTMLElement | null
  active: boolean
}): ActivityTerminalPortalTarget[] {
  if (!args.handle || !args.target || !args.element) {
    return []
  }
  // An empty paneKey shows the whole tab, which is the honest fallback when the
  // layout has not resolved a durable leaf for this terminal yet.
  const paneKey =
    args.target.leafId && isTerminalLeafId(args.target.leafId)
      ? makePaneKey(args.target.tabId, args.target.leafId)
      : ''
  return [
    {
      slotId: LOCAL_RUN_PANE_SLOT_ID,
      requestToken: `${LOCAL_RUN_PANE_SLOT_ID}:${args.handle}:${paneKey}`,
      target: args.element,
      worktreeId: args.target.worktreeId,
      tabId: args.target.tabId,
      paneKey,
      mounted: true,
      visible: true,
      focused: args.active,
      active: args.active
    }
  ]
}
