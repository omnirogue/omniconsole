import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import type { AttentionPane } from './agent-pane-snapshot'

export type AttentionSlotId = 'current' | 'needs-you'

export const ATTENTION_CURRENT_SLOT_ID = 'attention-current'
export const ATTENTION_NEEDS_YOU_SLOT_ID = 'attention-needs-you'

/** The pane the user is working in. An empty `paneKey` shows the whole tab. */
export type AttentionCurrentPaneRef = {
  worktreeId: string
  tabId: string
  paneKey: string
}

export type AttentionSlotResolution = {
  needsYou: AttentionPane | null
  /** Panes that could fill the slot, oldest wait first (the current pane excluded). */
  candidates: AttentionPane[]
  /** Position of `needsYou` among the candidates; -1 while a cleared pane is only held. */
  index: number
  total: number
  /** True when the pane no longer needs input but stays because the user is still in it. */
  held: boolean
  /** True when the pane sits in the same tab as the current pane, so the current slot shows the whole tab instead. */
  sharesCurrentTab: boolean
}

function isCurrentPane(pane: AttentionPane, current: AttentionCurrentPaneRef | null): boolean {
  if (!current || pane.worktreeId !== current.worktreeId) {
    return false
  }
  if (current.paneKey === '') {
    return pane.tabId === current.tabId
  }
  return pane.portalPaneKey === current.paneKey
}

function samePane(left: AttentionPane, right: AttentionPane): boolean {
  return left.paneKey === right.paneKey && left.worktreeId === right.worktreeId
}

export function clampAttentionCursor(cursor: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return ((Math.trunc(cursor) % total) + total) % total
}

/**
 * Pick what the "needs you" slot shows. Precedence: the pane the user picked
 * with Next/Prev (`selectedPaneKey`) while it still waits; then, while the user
 * is in the slot (`holdActive`), the pane they are in — kept even after it
 * stopped needing input; otherwise the oldest waiting pane.
 */
export function resolveAttentionSlots(args: {
  current: AttentionCurrentPaneRef | null
  attention: readonly AttentionPane[]
  heldPane: AttentionPane | null
  holdActive: boolean
  selectedPaneKey: string | null
}): AttentionSlotResolution {
  const candidates = args.attention.filter((pane) => !isCurrentPane(pane, args.current))
  const total = candidates.length
  let needsYou: AttentionPane | null = null
  let index = -1
  let held = false
  const selectedIndex =
    args.selectedPaneKey === null
      ? -1
      : candidates.findIndex((pane) => pane.paneKey === args.selectedPaneKey)
  if (selectedIndex !== -1) {
    needsYou = candidates[selectedIndex] ?? null
    index = selectedIndex
  } else if (args.holdActive && args.heldPane) {
    const heldIndex = candidates.findIndex((pane) => samePane(pane, args.heldPane!))
    if (heldIndex !== -1) {
      needsYou = candidates[heldIndex] ?? null
      index = heldIndex
    } else {
      needsYou = args.heldPane
      held = true
    }
  } else if (total > 0) {
    index = 0
    needsYou = candidates[0] ?? null
  }
  const sharesCurrentTab = Boolean(
    needsYou &&
    args.current &&
    needsYou.worktreeId === args.current.worktreeId &&
    needsYou.tabId === args.current.tabId
  )
  return { needsYou, candidates, index, total, held, sharesCurrentTab }
}

export function buildAttentionPortalDescriptors(args: {
  current: AttentionCurrentPaneRef | null
  currentTarget: HTMLElement | null
  needsYou: AttentionPane | null
  needsYouTarget: HTMLElement | null
  sharesCurrentTab: boolean
  focusedSlot: AttentionSlotId
}): ActivityTerminalPortalTarget[] {
  const descriptors: ActivityTerminalPortalTarget[] = []
  if (args.current && args.currentTarget) {
    // Why: one TerminalPane serves a tab, so a same-tab attention pane is shown by un-isolating the current tab.
    const paneKey = args.sharesCurrentTab ? '' : args.current.paneKey
    descriptors.push({
      slotId: ATTENTION_CURRENT_SLOT_ID,
      requestToken: `${ATTENTION_CURRENT_SLOT_ID}:${args.current.tabId}:${paneKey}`,
      target: args.currentTarget,
      worktreeId: args.current.worktreeId,
      tabId: args.current.tabId,
      paneKey,
      mounted: true,
      visible: true,
      focused: args.focusedSlot === 'current' || args.sharesCurrentTab,
      active: args.focusedSlot === 'current' || args.sharesCurrentTab
    })
  }
  if (args.needsYou?.portalPaneKey && args.needsYouTarget && !args.sharesCurrentTab) {
    descriptors.push({
      slotId: ATTENTION_NEEDS_YOU_SLOT_ID,
      requestToken: `${ATTENTION_NEEDS_YOU_SLOT_ID}:${args.needsYou.portalPaneKey}`,
      target: args.needsYouTarget,
      worktreeId: args.needsYou.worktreeId,
      tabId: args.needsYou.tabId,
      paneKey: args.needsYou.portalPaneKey,
      mounted: true,
      visible: true,
      focused: args.focusedSlot === 'needs-you',
      active: args.focusedSlot === 'needs-you'
    })
  }
  return descriptors
}
