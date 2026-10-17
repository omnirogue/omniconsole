// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionGrid } from '@/store/session-grid'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { i18n } from '../../i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '../../i18n/pseudo-localization'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  openTaskPage: vi.fn(),
  openAutomationsPage: vi.fn(),
  openActivityPage: vi.fn(),
  openMobilePage: vi.fn(),
  openArtifactsPage: vi.fn(),
  openSkillsPage: vi.fn(),
  openOfficePage: vi.fn(),
  openBuildReviewPage: vi.fn(),
  openWorkPage: vi.fn(),
  openWorkHomePage: vi.fn(),
  openInboxPage: vi.fn(),
  openCompaniesPage: vi.fn(),
  openLocalRunsPage: vi.fn(),
  toggleAttentionPage: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarSessionSurface: vi.fn(),
  openModal: vi.fn(),
  updateSettings: vi.fn(),
  refreshPreflightStatus: vi.fn(),
  checkLinearConnection: vi.fn(),
  hasPairedMobileDevice: false,
  agentBucketCounts: { attention: 0, working: 0, done: 0, idle: 0 },
  getAgentBucketCounts: vi.fn(),
  dismissMobileOnboardingBadge: vi.fn(),
  setSetupGuideSidebarDismissed: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/store/selectors', () => ({
  useRepoMap: () =>
    new Map(
      ((mocks.state.repos as Repo[] | undefined) ?? []).map((repo) => [repo.id, repo] as const)
    ),
  // Why: the Work badge asks which workspace a waiting pane belongs to; this nav has no panes.
  useWorktreeMap: () => new Map()
}))

vi.mock('@/components/activity/useActivityUnreadCount', () => ({
  useActivityUnreadCount: () => 0
}))

vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => ({ attention: [] })
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => {
    mocks.getAgentBucketCounts()
    return mocks.agentBucketCounts
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyComboDetails: () => [{ keys: ['⌘', 'J'], doubleTap: false }]
}))

vi.mock('./mobile-sidebar-onboarding-badge', () => ({
  useMobileSidebarOnboardingBadge: () => ({
    visible: false,
    hasPairedDevice: mocks.hasPairedMobileDevice,
    dismiss: mocks.dismissMobileOnboardingBadge
  })
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: () => ({
    ready: true,
    coreDoneCount: 0,
    coreTotal: 1,
    stepDone: {}
  })
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

import SidebarNav, {
  getSetupGuideSidebarEntryReady,
  shouldShowAgentDashboardButton,
  shouldShowAgentsButton,
  shouldShowAutomationsButton,
  shouldShowArtifactsButton,
  shouldShowMobileButton,
  shouldShowSetupGuideEntry
} from './SidebarNav'

function gitRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo-1',
    displayName: 'repo-1',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'git'
  }
}

function folderRepo(): Repo {
  return {
    id: 'folder-1',
    path: '/tmp/folder-1',
    displayName: 'folder-1',
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'folder'
  }
}

function setSidebarState({
  settings = getDefaultSettings('/tmp'),
  repos = [gitRepo()],
  activeView = 'work'
}: {
  settings?: GlobalSettings
  repos?: Repo[]
  activeView?: string
} = {}): void {
  mocks.state = {
    settings,
    repos,
    activeView,
    openTaskPage: mocks.openTaskPage,
    openSkillsPage: mocks.openSkillsPage,
    openOfficePage: mocks.openOfficePage,
    openBuildReviewPage: mocks.openBuildReviewPage,
    openWorkPage: mocks.openWorkPage,
    openWorkHomePage: mocks.openWorkHomePage,
    openInboxPage: mocks.openInboxPage,
    openCompaniesPage: mocks.openCompaniesPage,
    openLocalRunsPage: mocks.openLocalRunsPage,
    toggleAttentionPage: mocks.toggleAttentionPage,
    setActiveView: mocks.setActiveView,
    setSidebarSessionSurface: mocks.setSidebarSessionSurface,
    sidebarSessionSurface: 'workspaces',
    openAutomationsPage: mocks.openAutomationsPage,
    openActivityPage: mocks.openActivityPage,
    openMobilePage: mocks.openMobilePage,
    openArtifactsPage: mocks.openArtifactsPage,
    openModal: mocks.openModal,
    updateSettings: mocks.updateSettings,
    preflightStatus: { glab: { installed: false } },
    preflightStatusChecked: true,
    refreshPreflightStatus: mocks.refreshPreflightStatus,
    linearStatus: { connected: false },
    linearStatusChecked: true,
    checkLinearConnection: mocks.checkLinearConnection,
    prefetchWorkItems: vi.fn(),
    activeRepoId: null,
    persistedUIReady: true,
    activeModal: null,
    setupGuideSidebarDismissed: true,
    setSetupGuideSidebarDismissed: mocks.setSetupGuideSidebarDismissed
  }
}

const mountedRoots: Root[] = []

async function renderSidebarNav(expandAgents = true): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SidebarNav />
      </TooltipProvider>
    )
  })
  if (expandAgents && !container.querySelector('[data-nav-group-members="work"]')) {
    await clickButton(
      container.querySelector('button[data-nav-group="agents"]') as HTMLButtonElement
    )
  }
  return container
}

function queryButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === text
    ) ?? null
  )
}

function getButtonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = queryButtonByText(container, text)
  if (!button) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function getHideButton(menu: Element): HTMLButtonElement {
  const button =
    Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).find((candidate) =>
      candidate.textContent?.includes('Hide from sidebar')
    ) ?? null
  if (!button) {
    throw new Error('Hide from sidebar button not found')
  }
  return button
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('SidebarNav', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    useSessionGrid.getState().cancelPendingWrites()
    document.body.innerHTML = ''
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    useSessionGrid.getState().cancelPendingWrites()
    useSessionGrid.setState(useSessionGrid.getInitialState(), true)
    localStorage.clear()
    await i18n.changeLanguage('en')
    mocks.hasPairedMobileDevice = false
    mocks.agentBucketCounts = { attention: 0, working: 0, done: 0, idle: 0 }
    setSidebarState()
  })

  it('keeps enabled command-center storage when the grid sidebar entry mounts', async () => {
    setSidebarState({ settings: { ...getDefaultSettings('/tmp'), commandCenter: true } })
    useSessionGrid.getState().load(true)
    const layout = useSessionGrid.getState().layout
    const container = await renderSidebarNav()
    expect(container.querySelector('[data-session-grid-count="4"]')).not.toBeNull()
    expect(useSessionGrid.getState().commandCenter).toBe(true)
    expect(useSessionGrid.getState().layout).toBe(layout)
  })

  it('opens the restored Inbox from its Work navigation entry', async () => {
    const container = await renderSidebarNav()
    expect(queryButtonByText(container, 'Inbox')).not.toBeNull()
    await act(async () => getButtonByText(container, 'Inbox').click())
    expect(mocks.openInboxPage).toHaveBeenCalledTimes(1)
  })

  it('hides the Agents entry while settings are loading', () => {
    expect(shouldShowAgentsButton(null)).toBe(false)
  })

  it('hides the Agents entry while the experimental Agents view is off', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: false
      })
    ).toBe(false)
  })

  it('shows the Agents entry when the experimental Agents view is on', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: true
      })
    ).toBe(true)
  })

  it('shows the Agent Dashboard entry only when its experiment is enabled', () => {
    expect(shouldShowAgentDashboardButton(null)).toBe(false)
    expect(shouldShowAgentDashboardButton({ experimentalAgentDashboardPopout: false })).toBe(false)
    expect(shouldShowAgentDashboardButton({ experimentalAgentDashboardPopout: true })).toBe(true)
  })

  it('keeps the Agent Dashboard row unmounted by default', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    expect(queryButtonByText(container, 'Agent Dashboard')).toBeNull()
    expect(mocks.getAgentBucketCounts).not.toHaveBeenCalled()
  })

  it('mounts the Agent Dashboard row after opt-in', async () => {
    setSidebarState({
      activeView: 'buildReview',
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalAgentDashboardPopout: true
      }
    })
    const container = await renderSidebarNav()

    await waitFor(() => expect(queryButtonByText(container, 'Agent Dashboard')).not.toBeNull())
    expect(mocks.getAgentBucketCounts).toHaveBeenCalledTimes(1)
  })

  it('uses a question glyph only for the Needs You count', async () => {
    mocks.agentBucketCounts = { attention: 2, working: 3, done: 1, idle: 4 }
    setSidebarState({
      activeView: 'buildReview',
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalAgentDashboardPopout: true,
        experimentalAgentDashboardShowIdle: true
      }
    })
    const container = await renderSidebarNav()

    await waitFor(() =>
      expect(container.querySelector('[aria-label="Needs You: 2"]')).not.toBeNull()
    )
    const attention = container.querySelector('[aria-label="Needs You: 2"]')
    const working = container.querySelector('[aria-label="Working: 3"]')
    const done = container.querySelector('[aria-label="Done: 1"]')
    const idle = container.querySelector('[aria-label="Idle: 4"]')
    expect(attention?.querySelector('.lucide-message-circle-question-mark')).not.toBeNull()
    expect(working?.querySelector('.rounded-full')).not.toBeNull()
    expect(done?.querySelector('.rounded-full')).not.toBeNull()
    expect(idle?.querySelector('.rounded-full')).not.toBeNull()
    expect(working?.querySelector('svg')).toBeNull()
    expect(done?.querySelector('svg')).toBeNull()
    expect(idle?.querySelector('svg')).toBeNull()
  })

  it('shows the Mobile entry by default for older settings', () => {
    expect(shouldShowMobileButton(null)).toBe(true)
    expect(shouldShowMobileButton({})).toBe(true)
  })

  it('hides the Artifacts entry by default for older settings', () => {
    expect(shouldShowArtifactsButton(null)).toBe(false)
    expect(shouldShowArtifactsButton({})).toBe(false)
    expect(shouldShowArtifactsButton({ showArtifactsButton: true })).toBe(true)
    expect(shouldShowArtifactsButton({ showArtifactsButton: false })).toBe(false)
  })

  it('opens Artifacts from the sidebar', async () => {
    setSidebarState({
      activeView: 'artifacts',
      settings: { ...getDefaultSettings('/tmp'), showArtifactsButton: true }
    })
    const container = await renderSidebarNav()

    await clickButton(getButtonByText(container, 'Artifacts'))

    expect(mocks.openArtifactsPage).toHaveBeenCalledOnce()
  })

  it('hides Artifacts from its context menu', async () => {
    setSidebarState({
      activeView: 'artifacts',
      settings: { ...getDefaultSettings('/tmp'), showArtifactsButton: true }
    })
    const container = await renderSidebarNav()
    const row = getButtonByText(container, 'Artifacts')
    const menu = row.closest('[data-testid="context-menu"]')

    await clickButton(getHideButton(menu as Element))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showArtifactsButton: false })
  })

  it('hides the Mobile entry when the sidebar setting is off', () => {
    expect(shouldShowMobileButton({ showMobileButton: false })).toBe(false)
  })

  it('updates localized labels when the language changes after mount', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    expect(queryButtonByText(container, 'Automations')).not.toBeNull()
    expect(queryButtonByText(container, 'OmniConsole Mobile')).not.toBeNull()

    await act(async () => {
      await i18n.changeLanguage('zh')
    })

    expect(queryButtonByText(container, '自动化')).not.toBeNull()
    expect(queryButtonByText(container, 'OmniConsole 手机端')).not.toBeNull()
  })

  it('updates labels when pseudo-localization is enabled after mount', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    await act(async () => {
      await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    })

    expect(queryButtonByText(container, '[Automations]')).not.toBeNull()
    expect(queryButtonByText(container, '[OmniConsole Mobile]')).not.toBeNull()
  })

  it('shows the inline hide control only once a device is paired', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const beforePairing = await renderSidebarNav()
    expect(queryButtonByText(beforePairing, 'OmniConsole Mobile')).not.toBeNull()
    expect(beforePairing.querySelector('button[aria-label="Hide from sidebar"]')).toBeNull()

    mocks.hasPairedMobileDevice = true
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()
    const hideButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide from sidebar"]'
    )

    expect(queryButtonByText(container, 'OmniConsole Mobile')).not.toBeNull()
    expect(hideButton).not.toBeNull()
    expect(hideButton?.querySelector('svg')).not.toBeNull()

    await clickButton(hideButton as HTMLButtonElement)

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showMobileButton: false })
    expect(mocks.openMobilePage).not.toHaveBeenCalled()
  })

  it('shows the Automations entry by default for older settings', () => {
    expect(shouldShowAutomationsButton(null)).toBe(true)
    expect(shouldShowAutomationsButton({})).toBe(true)
  })

  it('hides the Automations entry when the sidebar setting is off', () => {
    expect(shouldShowAutomationsButton({ showAutomationsButton: false })).toBe(false)
  })

  it('omits the Automations row when the sidebar setting is off', async () => {
    setSidebarState({
      activeView: 'buildReview',
      settings: {
        ...getDefaultSettings('/tmp'),
        showAutomationsButton: false
      }
    })

    const container = await renderSidebarNav()

    expect(queryButtonByText(container, 'Automations')).toBeNull()
  })

  it('hides Automations from its sidebar context menu', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    const automationsMenu = getButtonByText(container, 'Automations').closest(
      '[data-testid="context-menu"]'
    )
    expect(automationsMenu).not.toBeNull()

    await clickButton(getHideButton(automationsMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showAutomationsButton: false })
  })

  it('hides Mobile from its sidebar context menu', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    const mobileMenu = getButtonByText(container, 'OmniConsole Mobile').closest(
      '[data-testid="context-menu"]'
    )
    expect(mobileMenu).not.toBeNull()

    await clickButton(getHideButton(mobileMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showMobileButton: false })
  })

  it('places the worktree palette search above the sidebar nav rows', async () => {
    const container = await renderSidebarNav()
    const nav = container.querySelector('[data-contextual-tour-target="sidebar-navigation"]')
    const searchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search worktrees and browser tabs"]'
    )
    const tasksButton = getButtonByText(container, 'Tasks')

    expect(nav?.firstElementChild).toBe(searchButton)
    if (!searchButton) {
      throw new Error('worktree palette search button not rendered')
    }
    expect(
      searchButton.compareDocumentPosition(tasksButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('hides the worktree palette shortcut until the search field is hovered or focused', async () => {
    const container = await renderSidebarNav()

    const searchButton = container.querySelector(
      'button[aria-label="Search worktrees and browser tabs"]'
    )
    expect(searchButton).not.toBeNull()
    expect(searchButton?.className).toContain('bg-worktree-sidebar-foreground/5')

    const shortcuts = searchButton?.querySelector('span.hidden')
    expect(shortcuts?.className).toContain('hidden')
    expect(shortcuts?.className).toContain('group-hover:flex')
    expect(shortcuts?.className).toContain('group-focus-within:flex')
    expect(shortcuts?.textContent).toContain('⌘')
    expect(shortcuts?.textContent).toContain('J')
    expect(searchButton?.querySelector('kbd')).toBeNull()
  })

  it('offers no per-provider task shortcuts once console-only was chosen', async () => {
    setSidebarState({
      settings: { ...getDefaultSettings('/tmp'), taskSourcesMode: 'console-only' }
    })
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    expect(
      tasksButton.parentElement?.querySelector('button[aria-label="Open GitHub tasks"]')
    ).toBeNull()
    expect(
      tasksButton.parentElement?.querySelector('button[aria-label="Open Jira tasks"]')
    ).toBeNull()
  })

  it('keeps task source shortcuts keyboard-reachable and revealed on Tasks row hover or focus', async () => {
    setSidebarState({
      settings: { ...getDefaultSettings('/tmp'), taskSourcesMode: 'all' }
    })
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    const githubShortcut = tasksButton.parentElement?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open GitHub tasks"]'
    )
    expect(githubShortcut).not.toBeNull()
    expect(githubShortcut?.tabIndex).toBe(0)
    expect(tasksButton.contains(githubShortcut ?? null)).toBe(false)

    const shortcuts = githubShortcut?.parentElement
    expect(shortcuts?.className).toContain('can-hover:opacity-0')
    expect(shortcuts?.className).toContain('can-hover:group-hover:opacity-100')
    expect(shortcuts?.className).toContain('can-hover:group-focus-within:opacity-100')
  })

  it('hides available Tasks from its sidebar context menu', async () => {
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')

    const tasksMenu = tasksButton.closest('[data-testid="context-menu"]')
    expect(tasksMenu).not.toBeNull()
    await clickButton(getHideButton(tasksMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showTasksButton: false })
  })

  it('keeps Tasks enabled with no git repos so the page can explain the empty state', async () => {
    setSidebarState({
      repos: [folderRepo()],
      settings: { ...getDefaultSettings('/tmp'), taskSourcesMode: 'all' }
    })
    const container = await renderSidebarNav()

    const tasksButton = getButtonByText(container, 'Tasks')
    expect(tasksButton.getAttribute('aria-disabled')).toBeNull()
    expect(tasksButton.disabled).toBe(false)
    expect(tasksButton.className).not.toContain('opacity-50')
    expect(
      tasksButton.parentElement?.querySelector('button[aria-label="Open GitHub tasks"]')
    ).not.toBeNull()

    await clickButton(tasksButton)
    expect(mocks.openTaskPage).toHaveBeenCalled()

    const tasksMenu = tasksButton.closest('[data-testid="context-menu"]')
    expect(tasksMenu).not.toBeNull()
    await clickButton(getHideButton(tasksMenu as HTMLElement))

    expect(mocks.updateSettings).toHaveBeenCalledWith({ showTasksButton: false })
  })

  it('shows the setup guide entry only after readiness, before completion, and before explicit hide', () => {
    expect(
      shouldShowSetupGuideEntry({ ready: false, setupComplete: false, dismissed: false })
    ).toBe(false)
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: false })).toBe(
      true
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: true, dismissed: false })).toBe(
      false
    )
    expect(shouldShowSetupGuideEntry({ ready: true, setupComplete: false, dismissed: true })).toBe(
      false
    )
  })

  it('requires both persisted UI and setup progress readiness before showing setup guide entry', () => {
    expect(getSetupGuideSidebarEntryReady(false, true)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, false)).toBe(false)
    expect(getSetupGuideSidebarEntryReady(true, true)).toBe(true)
  })

  it('always renders the two primary destinations, with no Conversations entry above Agents', async () => {
    const container = await renderSidebarNav()

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-nav-group]')).map(
        (button) => button.getAttribute('data-nav-group')
      )
    ).toEqual(['work', 'agents'])
    // Why: the Conversations tab below Agents is the sidebar's one place for them.
    expect(container.textContent).not.toContain('Conversations')
  })

  it('omits Companies even when a saved Companies view was active', async () => {
    setSidebarState({ activeView: 'companies' })
    const container = await renderSidebarNav(false)
    expect(container.querySelector('[data-nav-group="companies"]')).toBeNull()
    expect(container.querySelector('[data-testid="companies-tree"]')).toBeNull()
  })

  it('renders members only under the group that owns the active view', async () => {
    const container = await renderSidebarNav()

    expect(container.querySelector('[data-nav-group-members="work"]')).not.toBeNull()
    expect(container.querySelector('[data-nav-group-members="agents"]')).toBeNull()
    expect(queryButtonByText(container, 'Tasks')).not.toBeNull()
    expect(queryButtonByText(container, 'Attention')).not.toBeNull()
    // Jobs remain in Work; Inbox is restored for shared conversations.
    expect(queryButtonByText(container, 'Jobs')).toBeNull()
    expect(queryButtonByText(container, 'Inbox')).not.toBeNull()
    expect(queryButtonByText(container, 'Automations')).toBeNull()
    expect(queryButtonByText(container, 'Build + Review')).toBeNull()
  })

  it('indents the active group members beneath their primary', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    const members = container.querySelector('[data-nav-group-members="agents"]')
    expect(members?.className).toContain('pl-6')
    expect(members?.contains(getButtonByText(container, 'Build + Review'))).toBe(true)
    expect(container.querySelector('[data-nav-group-members="work"]')).toBeNull()
    expect(queryButtonByText(container, 'Tasks')).toBeNull()
  })

  it('opens the Work home and marks it current on the work view', async () => {
    const container = await renderSidebarNav()
    const work = container.querySelector<HTMLButtonElement>('button[data-nav-group="work"]')

    expect(work?.getAttribute('aria-current')).toBe('page')
    await clickButton(work as HTMLButtonElement)

    expect(mocks.openWorkPage).toHaveBeenCalledOnce()
    expect(queryButtonByText(container, 'Work home')).toBeNull()
  })

  for (const activeView of ['attention', 'grid']) {
    it(`marks Work current in ${activeView} and retains every Work shortcut when enabled`, async () => {
      setSidebarState({
        settings: { ...getDefaultSettings('/tmp'), commandCenter: true },
        activeView
      })
      const container = await renderSidebarNav()
      const work = container.querySelector<HTMLButtonElement>('button[data-nav-group="work"]')!
      expect(work.getAttribute('aria-current')).toBe('page')
      const members = container.querySelector('[data-nav-group-members="work"]')!
      for (const label of [
        'Work home',
        'Projects',
        'Decisions',
        'Inbox',
        'Attention',
        'Tasks',
        'Kanban',
        'Calendar',
        'Advertising'
      ]) {
        expect(members.contains(getButtonByText(container, label))).toBe(true)
      }
      expect(members.querySelector('button[data-session-grid-count]')).not.toBeNull()
      await clickButton(getButtonByText(container, 'Work home'))
      expect(mocks.openWorkHomePage).toHaveBeenCalledOnce()
      await clickButton(work)
      expect(mocks.openWorkPage).toHaveBeenCalledOnce()
    })
  }

  it('marks the Work home row current without marking the command center current', async () => {
    setSidebarState({ settings: { ...getDefaultSettings('/tmp'), commandCenter: true } })
    const container = await renderSidebarNav()
    expect(getButtonByText(container, 'Work home').getAttribute('aria-current')).toBe('page')
    expect(
      container.querySelector('button[data-nav-group="work"]')?.getAttribute('aria-current')
    ).toBeNull()
  })

  it('marks the active member instead of the primary once a member page is open', async () => {
    setSidebarState({ activeView: 'tasks' })
    const container = await renderSidebarNav()

    expect(
      container
        .querySelector<HTMLButtonElement>('button[data-nav-group="work"]')
        ?.getAttribute('aria-current')
    ).toBeNull()
    expect(getButtonByText(container, 'Tasks').getAttribute('aria-current')).toBe('page')
  })

  it('draws Build + Review with the wrench, the Build + Review preset icon', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav()

    const buildReview = getButtonByText(container, 'Build + Review')
    expect(buildReview.querySelector('.lucide-wrench')).not.toBeNull()
    expect(buildReview.querySelector('.lucide-workflow')).toBeNull()
  })

  it('lists Local runs under Agents and opens it from there', async () => {
    setSidebarState({ activeView: 'localRuns' })
    const container = await renderSidebarNav()

    const members = container.querySelector('[data-nav-group-members="agents"]')
    const localRuns = getButtonByText(container, 'Local runs')
    expect(members?.contains(localRuns)).toBe(true)
    expect(localRuns.getAttribute('aria-current')).toBe('page')
    await clickButton(localRuns)
    expect(mocks.openLocalRunsPage).toHaveBeenCalledOnce()
  })

  it('marks no primary destination current while a conversation is open', async () => {
    setSidebarState({ activeView: 'terminal' })
    const container = await renderSidebarNav()

    expect(container.querySelector('button[data-nav-group][aria-current="page"]')).toBeNull()
  })

  it('starts Agents collapsed even on an agent page and toggles without navigating', async () => {
    setSidebarState({ activeView: 'buildReview' })
    const container = await renderSidebarNav(false)
    const agents = container.querySelector('button[data-nav-group="agents"]') as HTMLButtonElement
    expect(agents.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-nav-group-members="agents"]')).toBeNull()
    await clickButton(agents)
    expect(agents.getAttribute('aria-expanded')).toBe('true')
    expect(getButtonByText(container, 'Build + Review')).toBeTruthy()
    await clickButton(agents)
    expect(agents.getAttribute('aria-expanded')).toBe('false')
    expect(mocks.openOfficePage).not.toHaveBeenCalled()
    expect(mocks.openBuildReviewPage).not.toHaveBeenCalled()
  })
})
