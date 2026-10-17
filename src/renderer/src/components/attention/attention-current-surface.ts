import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '../terminal-pane/terminal-layout-leaf-ids'
import type { AttentionCurrentPaneRef } from './attention-slot'

export type AttentionCurrentPane = AttentionCurrentPaneRef & {
  label: string
  agent: TuiAgent | null
}

export type AttentionCurrentSurface =
  | { kind: 'terminal'; pane: AttentionCurrentPane }
  | { kind: 'other'; worktreeId: string }
  | { kind: 'none' }

export type AttentionCurrentSurfaceInputs = Pick<
  AppState,
  'activeWorktreeId' | 'activeTabId' | 'activeTabType'
> & {
  tabs: readonly TerminalTab[]
  layout: TerminalLayoutSnapshot | undefined
}

// Why: `useShallow` compares one level, so a fresh `[]` per read breaks Zustand v5 snapshot
// identity and re-renders the page forever (React #185) whenever no workspace is active.
const EMPTY_TABS: readonly TerminalTab[] = []

export function selectAttentionCurrentSurfaceInputs(
  state: Pick<
    AppState,
    | 'activeWorktreeId'
    | 'activeTabId'
    | 'activeTabType'
    | 'tabsByWorktree'
    | 'terminalLayoutsByTabId'
  >
): AttentionCurrentSurfaceInputs {
  return {
    activeWorktreeId: state.activeWorktreeId,
    activeTabId: state.activeTabId,
    activeTabType: state.activeTabType,
    tabs:
      (state.activeWorktreeId ? state.tabsByWorktree[state.activeWorktreeId] : undefined) ??
      EMPTY_TABS,
    layout: state.activeTabId ? state.terminalLayoutsByTabId[state.activeTabId] : undefined
  }
}

function resolveCurrentLeafId(layout: TerminalLayoutSnapshot | undefined): string | null {
  if (!layout) {
    return null
  }
  if (layout.activeLeafId && isTerminalLeafId(layout.activeLeafId)) {
    return layout.activeLeafId
  }
  const first = collectLeafIdsInOrder(layout.root).find(isTerminalLeafId)
  if (first) {
    return first
  }
  const rootless = resolveRootlessTerminalLayoutLeafId(layout)
  return rootless && isTerminalLeafId(rootless) ? rootless : null
}

export function terminalTabLabel(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  leafId: string | null
): string {
  return (
    tab.customTitle ||
    (leafId ? layout?.titlesByLeafId?.[leafId] : undefined) ||
    tab.generatedTitle ||
    tab.title
  )
}

/** The terminal pane the user is working in, or why there is none to show. */
export function resolveAttentionCurrentSurface(
  inputs: AttentionCurrentSurfaceInputs
): AttentionCurrentSurface {
  const { activeWorktreeId, activeTabId } = inputs
  if (!activeWorktreeId) {
    return { kind: 'none' }
  }
  const tab = activeTabId ? inputs.tabs.find((candidate) => candidate.id === activeTabId) : null
  if (!tab || inputs.activeTabType !== 'terminal') {
    return { kind: 'other', worktreeId: activeWorktreeId }
  }
  const leafId = resolveCurrentLeafId(inputs.layout)
  return {
    kind: 'terminal',
    pane: {
      worktreeId: activeWorktreeId,
      tabId: tab.id,
      // Why: a tab whose layout has not settled yet still renders whole; isolation needs a resolved leaf.
      paneKey: leafId ? makePaneKey(tab.id, leafId) : '',
      label: terminalTabLabel(tab, inputs.layout, leafId),
      agent: tab.launchAgent ?? null
    }
  }
}
