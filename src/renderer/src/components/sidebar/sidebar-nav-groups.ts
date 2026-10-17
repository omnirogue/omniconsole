import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'

export type NavGroupId = 'work' | 'companies' | 'agents'

export type NavGroupDefinition = {
  id: NavGroupId
  /** The page the primary itself owns; `null` when the group lands on whichever member is shown. */
  primaryView: TopLevelView | null
  /** Every view that keeps this group open, the primary's own page included. */
  views: readonly TopLevelView[]
  labelKey: string
  labelFallback: string
  tooltipKey: string
  tooltipFallback: string
}

export const NAV_GROUPS: readonly NavGroupDefinition[] = [
  {
    id: 'work',
    primaryView: 'work',
    views: [
      'work',
      'project',
      'inbox',
      'attention',
      'grid',
      'tasks',
      'kanban',
      'calendar',
      'advertising'
    ],
    labelKey: 'nav.work',
    labelFallback: 'Work',
    tooltipKey: 'nav.workTooltip',
    tooltipFallback: 'What needs you, what is happening, how your companies are doing.'
  },
  {
    id: 'companies',
    primaryView: 'companies',
    views: ['companies'],
    labelKey: 'nav.companies',
    labelFallback: 'Companies',
    tooltipKey: 'nav.companiesTooltip',
    tooltipFallback: 'Company and domain work; start sessions here.'
  },
  {
    id: 'agents',
    primaryView: null,
    views: [
      'activity',
      'skills',
      'artifacts',
      'office',
      'buildReview',
      'localRuns',
      'machines',
      'automations',
      'mobile'
    ],
    labelKey: 'nav.agents',
    labelFallback: 'Agents',
    tooltipKey: 'nav.agentsTooltip',
    tooltipFallback: 'Agents, skills, artifacts and the office.'
  }
]

export function navGroup(id: NavGroupId): NavGroupDefinition {
  const group = NAV_GROUPS.find((candidate) => candidate.id === id)
  if (!group) {
    throw new Error(`Unknown sidebar nav group: ${id}`)
  }
  return group
}

/** The group a top-level view belongs to; Settings lives outside the nav, so it has none. */
export function navGroupForView(view: TopLevelView): NavGroupId | null {
  return NAV_GROUPS.find((group) => group.views.includes(view))?.id ?? null
}

/** Member views of a group, excluding the page the primary button itself opens. */
export function navGroupMemberViews(id: NavGroupId): readonly TopLevelView[] {
  const group = navGroup(id)
  return group.views.filter((view) => view !== group.primaryView)
}

export function shouldShowAgentsButton(
  settings: Pick<GlobalSettings, 'experimentalActivity'> | null | undefined
): boolean {
  return settings?.experimentalActivity === true
}

export function shouldShowAgentDashboardButton(
  settings: Pick<GlobalSettings, 'experimentalAgentDashboardPopout'> | null | undefined
): boolean {
  return settings?.experimentalAgentDashboardPopout === true
}

export function shouldShowMobileButton(
  settings: Pick<GlobalSettings, 'showMobileButton'> | null | undefined
): boolean {
  return settings?.showMobileButton !== false
}

export function shouldShowAutomationsButton(
  settings: Pick<GlobalSettings, 'showAutomationsButton'> | null | undefined
): boolean {
  return settings?.showAutomationsButton !== false
}

export function shouldShowArtifactsButton(
  settings: Pick<GlobalSettings, 'showArtifactsButton'> | null | undefined
): boolean {
  return settings?.showArtifactsButton === true
}

export function shouldShowOfficeButton(
  settings: Pick<GlobalSettings, 'showOfficeButton'> | null | undefined
): boolean {
  return settings?.showOfficeButton !== false
}

export function shouldShowSkillsButton(
  settings: Pick<GlobalSettings, 'showSkillsButton'> | null | undefined
): boolean {
  return settings?.showSkillsButton === true
}

export type AgentsGroupSettings = Pick<
  GlobalSettings,
  | 'showSkillsButton'
  | 'showArtifactsButton'
  | 'showOfficeButton'
  | 'showAutomationsButton'
  | 'showMobileButton'
  | 'experimentalActivity'
>

// Why: Build + Review has no hide setting, so it is the member that always answers.
const AGENTS_GROUP_LANDING_ORDER: readonly {
  view: TopLevelView
  isShown: (settings: AgentsGroupSettings | null | undefined) => boolean
}[] = [
  { view: 'skills', isShown: shouldShowSkillsButton },
  { view: 'artifacts', isShown: shouldShowArtifactsButton },
  { view: 'office', isShown: shouldShowOfficeButton },
  { view: 'buildReview', isShown: () => true },
  // Why: Local runs has no hide setting either; it lists this desktop's own runs.
  { view: 'localRuns', isShown: () => true },
  // Why: Machines lists the fleet the 🚀 popover dispatches to; it has no hide setting either.
  { view: 'machines', isShown: () => true },
  { view: 'automations', isShown: shouldShowAutomationsButton },
  { view: 'activity', isShown: shouldShowAgentsButton },
  { view: 'mobile', isShown: shouldShowMobileButton }
]

/** The page the Agents primary opens: its first member that the user has not hidden. */
export function agentsGroupDefaultView(
  settings: AgentsGroupSettings | null | undefined
): TopLevelView {
  return AGENTS_GROUP_LANDING_ORDER.find((entry) => entry.isShown(settings))?.view ?? 'buildReview'
}
