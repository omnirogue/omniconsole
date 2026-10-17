import React from 'react'
import { Bot, Folder, LayoutDashboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { isCommandCenterView } from '@/lib/command-center-navigation'
import { useAppStore } from '@/store'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import {
  EMPTY_SIDEBAR_LAYOUT,
  SIDEBAR_NAV_SCOPE,
  sidebarNavMemberScope
} from '../../../../shared/sidebar-layout'
import { InboxSidebarEntry } from './InboxSidebarEntry'
import { AdvertisingSidebarEntry } from './AdvertisingSidebarEntry'
import { DecisionsSidebarEntry } from './DecisionsSidebarEntry'
import AttentionSidebarEntry from './AttentionSidebarEntry'
import ProjectsSidebarEntry from './ProjectsSidebarEntry'
import SessionGridSidebarEntry from './SessionGridSidebarEntry'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'
import { useSidebarAgentsItems } from './SidebarAgentsGroupMembers'
import { useSidebarSettingsItems } from './use-sidebar-settings-items'
import {
  sidebarMemberScope,
  type SidebarMemberScope
} from '../../../../shared/sidebar-navigation-placement'
import { SidebarNavGroup } from './SidebarNavGroup'
import { SidebarNavMemberButton } from './SidebarNavMemberButton'
import { SidebarOrderedGroup, type OrderedSidebarItem } from './SidebarOrderedGroup'
import { SidebarSearchNavButton } from './SidebarSearchNavButton'
import { SidebarKanbanNavButton } from './SidebarKanbanNavButton'
import { SidebarCalendarNavButton } from './SidebarCalendarNavButton'
import { SidebarTaskNavButton } from './SidebarTaskNavButton'
import { useWorkNeedsYouCount, WorkNeedsYouBadge } from './WorkNeedsYouBadge'
import { navGroup, navGroupForView, shouldShowAgentDashboardButton } from './sidebar-nav-groups'

export { getSetupGuideSidebarEntryReady, shouldShowSetupGuideEntry } from './SetupGuideSidebarEntry'
export {
  shouldShowAgentDashboardButton,
  shouldShowAgentsButton,
  shouldShowArtifactsButton,
  shouldShowAutomationsButton,
  shouldShowMobileButton,
  shouldShowOfficeButton,
  shouldShowSkillsButton
} from './sidebar-nav-groups'

const AgentDashboardSidebarEntry = lazyWithRetry(() => import('./AgentDashboardSidebarEntry'))

const SidebarNav = React.memo(function SidebarNav() {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves OmniConsole's pseudo-localization behavior.
  useTranslation()
  const activeView = useAppStore((s) => s.activeView)
  const commandCenter = useAppStore((s) => s.settings?.commandCenter === true)
  const workCurrent = commandCenter ? isCommandCenterView(activeView) : activeView === 'work'
  const openWorkPage = useAppStore((s) => s.openWorkPage)
  const openWorkHomePage = useAppStore((s) => s.openWorkHomePage)
  const showAgentDashboardButton = useAppStore((s) => shouldShowAgentDashboardButton(s.settings))
  // Selection follows navigation; each group controls its own disclosure.
  const defaultActiveGroup = navGroupForView(activeView)
  // Why reveal: a hidden Work group must still appear while something needs the person.
  const needsYou = useWorkNeedsYouCount()

  const layout = useAppStore((s) => s.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const agentItems = useSidebarAgentsItems(
    showAgentDashboardButton ? (
      <React.Suspense fallback={null}>
        <AgentDashboardSidebarEntry />
      </React.Suspense>
    ) : null
  )
  const settingItems = useSidebarSettingsItems()
  const workItems: OrderedSidebarItem[] = [
    ...(commandCenter
      ? [
          {
            id: 'work:work',
            label: translate('commandCenter.content.page.work', 'Work home'),
            node: (
              <SidebarNavMemberButton
                icon={LayoutDashboard}
                label={translate('commandCenter.content.page.work', 'Work home')}
                active={activeView === 'work'}
                onClick={openWorkHomePage}
              />
            )
          }
        ]
      : []),
    {
      id: 'work:projects',
      label: translate('projects.nav', 'Projects'),
      node: <ProjectsSidebarEntry />
    },
    {
      id: 'work:decisions',
      label: translate('nav.decisions', 'Decisions'),
      node: <DecisionsSidebarEntry />
    },
    { id: 'work:inbox', label: translate('nav.inbox', 'Inbox'), node: <InboxSidebarEntry /> },
    // Why: onboarding is a Work concern, not a sixth destination.
    {
      id: 'work:setup',
      label: translate('nav.setupGuide', 'Setup guide'),
      node: <SetupGuideSidebarEntry />
    },
    {
      id: 'work:attention',
      label: translate('nav.attention', 'Attention'),
      reveal: needsYou > 0,
      node: <AttentionSidebarEntry />
    },
    {
      id: 'work:grid',
      label: translate('nav.grid', 'Grid'),
      node: <SessionGridSidebarEntry />
    },
    {
      id: 'work:tasks',
      label: translate('nav.tasks', 'Tasks'),
      node: <SidebarTaskNavButton />
    },
    // Why its own row: the board was three levels inside Tasks; it is a destination.
    {
      id: 'work:kanban',
      label: translate('nav.kanban', 'Kanban'),
      node: <SidebarKanbanNavButton />
    },
    {
      id: 'work:calendar',
      label: translate('nav.calendar', 'Calendar'),
      node: <SidebarCalendarNavButton />
    },
    {
      id: 'work:advertising',
      label: translate('nav.advertising', 'Advertising'),
      node: <AdvertisingSidebarEntry />
    }
  ]
  const itemsFor = (scope: SidebarMemberScope): OrderedSidebarItem[] => [
    ...workItems.filter((item) => sidebarMemberScope(layout, item.id, 'nav:work') === scope),
    ...agentItems.filter((item) => sidebarMemberScope(layout, item.id, 'nav:agents') === scope),
    ...settingItems.filter((item) => sidebarMemberScope(layout, item.id, null) === scope)
  ]

  const activeMember = defaultActiveGroup === 'work' ? `work:${activeView}` : `agents:${activeView}`
  const activeGroup =
    activeView === 'work'
      ? 'work'
      : sidebarMemberScope(
          layout,
          activeMember,
          defaultActiveGroup === 'agents'
            ? 'nav:agents'
            : defaultActiveGroup === 'work'
              ? 'nav:work'
              : null
        )?.slice(4)

  const groups: OrderedSidebarItem[] = [
    {
      id: 'nav:work',
      label: translate('nav.work', 'Work'),
      reveal: needsYou > 0,
      node: (
        <SidebarNavGroup
          group={navGroup('work')}
          icon={LayoutDashboard}
          active={activeGroup === 'work'}
          current={workCurrent}
          onOpen={openWorkPage}
          badge={<WorkNeedsYouBadge />}
        >
          {/* Why a scope of its own: the rows under Work reorder among themselves. */}
          <SidebarOrderedGroup
            scope={sidebarNavMemberScope('work')}
            rowDrag={false}
            items={itemsFor('nav:work')}
          />
        </SidebarNavGroup>
      )
    },
    // Why no Conversations entry here: the Conversations tab directly below Agents is the one
    // place the sidebar names them (SidebarSessionSurface), and a row opens its conversation.
    {
      id: 'nav:agents',
      label: translate('nav.agents', 'Agents'),
      reveal: itemsFor('nav:agents').some((item) => item.reveal),
      node: (
        <SidebarNavGroup
          group={navGroup('agents')}
          icon={Bot}
          active={activeGroup === 'agents'}
          current={false}
        >
          <SidebarOrderedGroup
            scope={sidebarNavMemberScope('agents')}
            items={itemsFor('nav:agents')}
            rowDrag={false}
          />
        </SidebarNavGroup>
      )
    },
    ...(layout.groups ?? []).map((group): OrderedSidebarItem => {
      const scope = `nav:${group.id}` as SidebarMemberScope
      const members = itemsFor(scope)
      return {
        id: scope,
        label: group.name,
        reveal: members.some((item) => item.reveal),
        node: (
          <SidebarNavGroup
            group={group}
            icon={Folder}
            active={activeGroup === group.id}
            current={false}
          >
            <SidebarOrderedGroup scope={scope} items={members} rowDrag={false} />
            {members.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {translate(
                  'sidebar.emptyGroup',
                  'Move shortcuts here using their menu or drag handles.'
                )}
              </p>
            ) : null}
          </SidebarNavGroup>
        )
      }
    })
  ]

  return (
    <div
      className="flex flex-col gap-0.5 px-2 pt-2 pb-1"
      data-contextual-tour-target="sidebar-navigation"
    >
      <SidebarSearchNavButton />
      {/* Why rowDrag false: a drag on every hover of a primary destination would
          invite accidents, so the handle appears only in Customize. */}
      <SidebarOrderedGroup scope={SIDEBAR_NAV_SCOPE} items={groups} rowDrag={false} />
    </div>
  )
})

export default SidebarNav
