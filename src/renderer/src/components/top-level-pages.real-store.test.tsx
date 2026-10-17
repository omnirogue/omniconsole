/** @vitest-environment happy-dom */
import { act, type ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from '@/store/session-grid'
import { useAppStore } from '@/store'
import { mountOnRealStore, resetRealStore, type RealStoreMount } from '@/test/mount-on-real-store'
import { getDefaultSettings } from '../../../shared/constants'
import type { TopLevelView } from '../../../shared/ui-chrome-types'

// Why: every top-level page must survive a mount on the REAL store with no active workspace —
// the exact state that looped the Attention page forever (React #185, PR #60). Only strips that
// need a live daemon are stubbed; `window.api` stays pending so each page draws its pre-data state.
vi.mock('./activity/activity-terminal-portal', () => ({ setActivityTerminalPortals: vi.fn() }))
vi.mock('./terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('./session-follow-up/SessionFollowUpButton', () => ({ SessionFollowUpButton: () => null }))
vi.mock('./attention/AttentionLaunchBar', () => ({
  AttentionLaunchBar: () => <div data-attention-launch-bar="" />
}))
vi.mock('./native-chat/NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))

type PageModule = { default: ComponentType }
type PageSmoke = { load: () => Promise<PageModule>; emptyState: string }

// Why: the same lazy imports AppWorkspaceShell routes `activeView` to; `terminal` with no
// workspace renders Landing there.
const PAGE_BY_VIEW: Record<TopLevelView, PageSmoke> = {
  inbox: { load: () => import('./inbox/InboxPage'), emptyState: 'Inbox' },
  terminal: { load: () => import('./Landing'), emptyState: 'Add a project to get started.' },
  settings: { load: () => import('./settings/Settings'), emptyState: 'Loading settings...' },
  // Why: every task source shows by default, so the empty GitHub source renders first.
  tasks: { load: () => import('./TaskPage'), emptyState: 'No project sources selected' },
  activity: {
    load: () => import('./activity/ActivityPrototypePage'),
    emptyState: 'No activity yet.'
  },
  automations: { load: () => import('./automations/AutomationsPage'), emptyState: 'Automations' },
  buildReview: {
    load: () => import('./build-review/BuildReviewPage'),
    emptyState: 'No build and review pipelines yet'
  },
  space: {
    load: () => import('./workspace-space/WorkspaceSpacePage'),
    emptyState: 'Run a scan to inspect workspace sizes.'
  },
  skills: { load: () => import('./skills/SkillsPage'), emptyState: 'Scanning skills' },
  artifacts: {
    load: () => import('./artifacts/ArtifactsPage'),
    emptyState: 'Sign in to view and manage artifacts'
  },
  mobile: { load: () => import('./mobile/MobilePage'), emptyState: 'Quick Actions' },
  office: { load: () => import('./office/OfficePage'), emptyState: 'Loading the office' },
  attention: {
    load: () => import('./session-grid/CommandCenterView'),
    emptyState: 'Pick a session in the sidebar'
  },
  companies: {
    load: () => import('./companies/CompaniesPage'),
    emptyState: 'Loading companies…'
  },
  localRuns: {
    load: () => import('./local-run/LocalRunsPage'),
    emptyState: 'Pick a graph on the left, or start a new one.'
  },
  // The heading and Refresh draw before any inventory answers.
  machines: { load: () => import('./fleet/MachinesPage'), emptyState: 'Machines' },
  work: { load: () => import('./work/WorkPage'), emptyState: 'Needs you' },
  // Signed out, the portfolio strip still renders with its own heading.
  advertising: {
    load: () => import('./advertising/AdvertisingPage'),
    emptyState: 'Advertising'
  },
  // The board's own heading draws before the work reads answer.
  kanban: { load: () => import('./work/KanbanPage'), emptyState: 'Kanban' },
  calendar: { load: () => import('./calendar/CalendarPage'), emptyState: 'Calendar' },
  // With no folders the overview draws its heading and the empty project grid.
  project: { load: () => import('./projects/SessionProjectsPage'), emptyState: 'No projects yet' },
  grid: {
    load: async () => {
      const { default: Page } = await import('./session-grid/CommandCenterView')
      return { default: () => <Page view="grid" /> }
    },
    emptyState: 'Drag sessions from the sidebar here'
  }
}

let mounted: RealStoreMount | null = null

beforeEach(() => {
  resetRealStore()
  useSessionGrid.getState().cancelPendingWrites()
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
  localStorage.clear()
})

afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  resetRealStore()
  useSessionGrid.getState().cancelPendingWrites()
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
  localStorage.clear()
  document.body.replaceChildren()
})

async function expectPageText(container: HTMLElement, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        return container.textContent
      },
      { timeout: 5_000 }
    )
    .toContain(text)
}

describe('top-level pages on the real store with no active workspace', () => {
  const entries = Object.entries(PAGE_BY_VIEW) as [TopLevelView, PageSmoke][]
  for (const [view, page] of entries) {
    it(`${view} page renders its empty state without throwing`, async () => {
      const { default: Page } = await page.load()
      useAppStore.setState({ activeWorktreeId: null, activeTabId: null })

      mounted = await mountOnRealStore(<Page />, { windowApi: 'pending' })

      await expectPageText(mounted.container, page.emptyState)
    })
  }
})

describe('command center mounts on the real store', () => {
  for (const commandCenter of [false, true]) {
    for (const view of ['attention', 'grid'] as const) {
      it(`${view} renders with commandCenter=${commandCenter}, no workspace and pending API`, async () => {
        const { default: Page } = await import('./session-grid/CommandCenterView')
        useAppStore.setState({
          settings: { ...getDefaultSettings('/tmp'), commandCenter },
          activeView: view,
          activeWorktreeId: null,
          activeTabId: null
        })
        mounted = await mountOnRealStore(<Page view={view} />, {
          windowApi: 'pending',
          settle: 100
        })
        await expectPageText(
          mounted.container,
          commandCenter
            ? 'New Claude / Codex'
            : view === 'grid'
              ? 'Drag sessions from the sidebar here'
              : 'Pick a session in the sidebar'
        )
        if (commandCenter) {
          expect(mounted.container.querySelectorAll('[data-session-grid-pane]')).toHaveLength(4)
        }
      })
    }
  }
})
