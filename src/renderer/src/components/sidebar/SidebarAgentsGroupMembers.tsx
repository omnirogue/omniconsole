import React from 'react'
import {
  Bell,
  BookOpen,
  Building2,
  CalendarClock,
  EyeOff,
  Files,
  Route,
  Server,
  Smartphone
} from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { useMobileSidebarOnboardingBadge } from './mobile-sidebar-onboarding-badge'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HideSidebarMenu } from './sidebar-nav-controls'
import { SidebarNavMemberButton } from './SidebarNavMemberButton'
import { translate } from '@/i18n/i18n'
import type { OrderedSidebarItem } from './SidebarOrderedGroup'
import { workflowPresetIconComponent } from '../local-workflows/workflow-presets'
import {
  shouldShowAgentsButton,
  shouldShowArtifactsButton,
  shouldShowAutomationsButton,
  shouldShowMobileButton,
  shouldShowOfficeButton,
  shouldShowSkillsButton
} from './sidebar-nav-groups'

function MobileSidebarMember(): React.JSX.Element {
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const mobileActive = useAppStore((s) => s.activeView === 'mobile')
  const onboardingBadge = useMobileSidebarOnboardingBadge(true)
  const hideMobileButton = React.useCallback(() => {
    void updateSettings({ showMobileButton: false })
  }, [updateSettings])
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex w-full items-center rounded-md text-[13px] font-medium tracking-tight transition-colors',
            mobileActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <button
            type="button"
            onClick={() => {
              onboardingBadge.dismiss()
              openMobilePage()
            }}
            aria-current={mobileActive ? 'page' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
          >
            <Smartphone
              className={cn(
                'size-4 shrink-0',
                !mobileActive && 'text-worktree-sidebar-foreground/30'
              )}
              strokeWidth={mobileActive ? 2.25 : 1.75}
            />
            <span className="min-w-0 flex-1 truncate">
              {translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'OmniConsole Mobile')}
            </span>
            {onboardingBadge.visible ? (
              <span className="shrink-0 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                {translate('auto.components.sidebar.SidebarNav.c86d83b5c3', 'New')}
              </span>
            ) : null}
          </button>
          {onboardingBadge.hasPairedDevice ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'mr-1 text-worktree-sidebar-foreground/55 hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground',
                    mobileActive &&
                      'text-worktree-sidebar-accent-foreground/70 hover:text-worktree-sidebar-accent-foreground'
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    hideMobileButton()
                  }}
                  aria-label={translate(
                    'auto.components.sidebar.SidebarNav.d599269755',
                    'Hide from sidebar'
                  )}
                >
                  <EyeOff className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <HideSidebarMenu onHide={hideMobileButton} />
    </ContextMenu>
  )
}

export function useSidebarAgentsItems(agentDashboardSlot?: React.ReactNode): OrderedSidebarItem[] {
  const openArtifactsPage = useAppStore((s) => s.openArtifactsPage)
  const openSkillsPage = useAppStore((s) => s.openSkillsPage)
  const openOfficePage = useAppStore((s) => s.openOfficePage)
  const openBuildReviewPage = useAppStore((s) => s.openBuildReviewPage)
  const openLocalRunsPage = useAppStore((s) => s.openLocalRunsPage)
  const openMachinesPage = useAppStore((s) => s.openMachinesPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const activeView = useAppStore((s) => s.activeView)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activityUnreadCount = useActivityUnreadCount(
    shouldShowAgentsButton(settings),
    'sidebar-badge'
  )
  const labelKeys = {
    artifacts: 'auto.components.sidebar.SidebarNav.artifacts',
    skills: 'auto.components.sidebar.SidebarNav.skills',
    office: 'auto.components.sidebar.SidebarNav.office',
    buildReview: 'auto.components.build-review.SidebarNav.title',
    localRuns: 'auto.components.local-run.Section.title',
    machines: 'machines.title',
    automations: 'auto.components.sidebar.SidebarNav.f323383e9a',
    activity: 'auto.components.sidebar.SidebarNav.9c95e1ce91'
  }
  const definitions = [
    [
      'artifacts',
      Files,
      'Artifacts',
      openArtifactsPage,
      shouldShowArtifactsButton(settings),
      'showArtifactsButton'
    ],
    [
      'skills',
      BookOpen,
      'Skills',
      openSkillsPage,
      shouldShowSkillsButton(settings),
      'showSkillsButton'
    ],
    [
      'office',
      Building2,
      '3D Office',
      openOfficePage,
      shouldShowOfficeButton(settings),
      'showOfficeButton'
    ],
    // Why the component, not <WorkflowPresetIcon>: this row sizes and weights its own icon.
    [
      'buildReview',
      workflowPresetIconComponent('build-review'),
      'Build + Review',
      openBuildReviewPage,
      true,
      null
    ],
    ['localRuns', Route, 'Local runs', openLocalRunsPage, true, null],
    ['machines', Server, 'Machines', openMachinesPage, true, null],
    [
      'automations',
      CalendarClock,
      'Automations',
      openAutomationsPage,
      shouldShowAutomationsButton(settings),
      'showAutomationsButton'
    ],
    ['activity', Bell, 'Agents', openActivityPage, shouldShowAgentsButton(settings), null]
  ] as const
  const items: OrderedSidebarItem[] = definitions
    .filter((entry) => entry[4])
    .map(([view, icon, label, action, , setting]) => ({
      id: `agents:${view}`,
      label: translate(labelKeys[view], label),
      node: (
        <SidebarNavMemberButton
          icon={icon}
          label={translate(labelKeys[view], label)}
          active={activeView === view}
          onClick={action}
          onHide={
            setting
              ? () => {
                  void updateSettings({ [setting]: false })
                }
              : undefined
          }
          badge={
            view === 'activity' && activityUnreadCount > 0 ? (
              <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                {activityUnreadCount}
              </span>
            ) : undefined
          }
        />
      )
    }))
  if (agentDashboardSlot) {
    items.push({
      id: 'agents:dashboard',
      label: translate('dashboard.sidebar.label', 'Agent Dashboard'),
      node: agentDashboardSlot
    })
  }
  if (shouldShowMobileButton(settings)) {
    items.push({
      id: 'agents:mobile',
      label: translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'OmniConsole Mobile'),
      node: <MobileSidebarMember />
    })
  }
  return items
}

export function SidebarAgentsGroupMembers({
  agentDashboardSlot
}: {
  agentDashboardSlot?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {useSidebarAgentsItems(agentDashboardSlot).map((item) => (
        <React.Fragment key={item.id}>{item.node}</React.Fragment>
      ))}
    </>
  )
}
