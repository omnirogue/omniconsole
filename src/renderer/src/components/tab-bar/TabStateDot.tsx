import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TerminalTabActivityStatus } from './terminal-tab-activity-status'

/** The two states a strip tab announces; everything else shows no dot. */
export type TabStateDotState = 'running' | 'needs-you' | 'waiting'

/**
 * Map the tab's resolved pane activity (the same fresh `agentStatusByPaneKey` read the
 * Up next header reflects, bucketed per tab by resolveTerminalTabActivityStatus) onto
 * the dot vocabulary: working/monitoring → running, blocked/waiting (permission) → needs
 * you; done/interrupted/idle → nothing.
 */
export function tabStateDotState(status: TerminalTabActivityStatus): TabStateDotState | null {
  switch (status) {
    case 'working':
      return 'running'
    case 'monitoring':
      return 'waiting'
    case 'permission':
      return 'needs-you'
    case 'active':
    case 'done':
    case 'inactive':
    case 'interrupted':
      return null
  }
}

/** Human label for the state, appended to the tab's accessible name ("… · running"). */
export function tabStateDotLabel(state: TabStateDotState): string {
  if (state === 'waiting') {
    return translate('tabStateDot.waiting', 'waiting')
  }
  return state === 'running'
    ? translate('tabStateDot.running', 'running')
    : translate('tabStateDot.needsYou', 'needs you')
}

// Why: a 6px dot at the tab's left edge reads at a glance across a saturated strip; the
// status tokens keep it in step with the Up next header's dot, and the pulse is dropped
// under prefers-reduced-motion.
export const TAB_STATE_DOT_CLASSES: Record<TabStateDotState, string> = {
  running: 'bg-status-info motion-safe:animate-pulse',
  'needs-you': 'bg-status-warning',
  waiting: 'bg-status-warning'
}

/** Render the per-tab state dot, or nothing when the tab has no live signal. */
export function TabStateDot({
  state
}: {
  state: TabStateDotState | null
}): React.JSX.Element | null {
  if (!state) {
    return null
  }
  return (
    <span
      aria-hidden
      data-testid="tab-state-dot"
      data-tab-state={state}
      className={cn('mr-1 size-1.5 shrink-0 rounded-full', TAB_STATE_DOT_CLASSES[state])}
    />
  )
}
