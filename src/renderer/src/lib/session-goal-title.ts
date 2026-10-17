import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import type { SessionGoal } from '../../../shared/session-goal'
import type { OrganizationTitleOrigin } from '../../../shared/session-organization-change'
import { isJunkSessionTitle } from '../../../shared/session-junk-title'
import { isGeneratedPromptScaffoldTitle } from '../../../shared/session-prompt-content'
import { fallbackConversationTitle } from './conversation-state'
import type { SidebarSession } from './sidebar-sessions'

type TitledSession = Pick<SidebarSession, 'label' | 'agent' | 'customTitle'>

/** The goal's first clause, capped like any generated title; null when it has none. */
export function sessionGoalTitle(goal: SessionGoal | null | undefined): string | null {
  if (!goal) {
    return null
  }
  return deriveGeneratedTabTitle(goal.full) ?? deriveGeneratedTabTitle(goal.line)
}

/** A name that says nothing about the work: a launcher id, a harness name or the agent placeholder. */
export function isJunkSessionLabel(session: Pick<SidebarSession, 'label' | 'agent'>): boolean {
  const label = session.label.trim()
  return (
    isJunkSessionTitle(label) ||
    isGeneratedPromptScaffoldTitle(label) ||
    label === session.agent ||
    label === fallbackConversationTitle(session.agent)
  )
}

/**
 * What a row shows. A title the person (or a launcher) set is theirs and shows as is; the app's
 * own junk title shows the goal instead, display-only, so nothing is written or lost.
 */
export function sessionDisplayTitle(
  session: TitledSession,
  goal: SessionGoal | null | undefined
): string {
  if (session.customTitle?.trim() || !isJunkSessionLabel(session)) {
    return session.label
  }
  return sessionGoalTitle(goal) ?? session.label
}

export type JunkTitleRepair = { tabId: string; previous: string; next: string }

/**
 * Rows whose own custom title is junk and whose goal gives a better one, one per tab (a tab's
 * panes share its title). A title the person chose is never offered, however it looks. Offered
 * to the person, never applied by itself.
 */
export function junkCustomTitleRepairs<T extends TitledSession & Pick<SidebarSession, 'tabId'>>(
  sessions: readonly T[],
  goalFor: (session: T) => SessionGoal | null | undefined,
  originFor: (tabId: string) => OrganizationTitleOrigin | undefined = () => undefined
): JunkTitleRepair[] {
  const repairs = new Map<string, JunkTitleRepair>()
  for (const session of sessions) {
    const previous = session.customTitle
    if (
      !session.tabId ||
      repairs.has(session.tabId) ||
      originFor(session.tabId) === 'yours' ||
      !isJunkSessionTitle(previous)
    ) {
      continue
    }
    const next = sessionGoalTitle(goalFor(session))
    if (next && next !== previous?.trim()) {
      repairs.set(session.tabId, { tabId: session.tabId, previous: previous as string, next })
    }
  }
  return [...repairs.values()]
}
