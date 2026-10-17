// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { resetGoalsTodosStoreForTests, seedGoalsTodosDetailsForTests } from './goals-todos-store'
import {
  publishSessionPullRequestFactsForTest,
  resetSessionPullRequestFactsForTest
} from './session-pull-request-facts-store'
import { SessionRowTodoBadge } from './SessionRowTodoBadge'

afterEach(() => {
  cleanup()
  resetGoalsTodosStoreForTests()
  resetSessionPullRequestFactsForTest()
})

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'wt',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:pane',
  kind: 'terminal',
  label: 'Pricing page',
  workspaceLabel: 'Website',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

function badge(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-session-todo-badge]')
}

describe('SessionRowTodoBadge', () => {
  it('renders nothing until the shared reads cached a list for the row', () => {
    render(
      <TooltipProvider>
        <SessionRowTodoBadge session={session} />
      </TooltipProvider>
    )
    expect(badge()).toBeNull()
    act(() =>
      seedGoalsTodosDetailsForTests('row-1', {
        goal: null,
        todos: [],
        source: 'none',
        lastMessageAt: null
      })
    )
    expect(badge()).toBeNull()
  })

  it('shows done over total once the row has a list, and follows later reads', () => {
    render(
      <TooltipProvider>
        <SessionRowTodoBadge session={session} />
      </TooltipProvider>
    )
    act(() =>
      seedGoalsTodosDetailsForTests('row-1', {
        goal: { line: 'Ship pricing', full: 'Ship pricing' },
        todos: [
          { text: 'Plan', status: 'completed' },
          { text: 'Build', status: 'current' }
        ],
        source: 'tool',
        lastMessageAt: null
      })
    )
    expect(badge()?.textContent).toBe('1/2')
    expect(badge()?.getAttribute('aria-label')).toBe('1 of 2 done')
    act(() =>
      seedGoalsTodosDetailsForTests('row-1', {
        goal: null,
        todos: [
          { text: 'Plan', status: 'completed' },
          { text: 'Build', status: 'completed' }
        ],
        source: 'tool',
        lastMessageAt: null
      })
    )
    expect(badge()?.textContent).toBe('2/2')
  })

  it("ignores another row's read", () => {
    render(
      <TooltipProvider>
        <SessionRowTodoBadge session={session} />
      </TooltipProvider>
    )
    act(() =>
      seedGoalsTodosDetailsForTests('row-2', {
        goal: null,
        todos: [{ text: 'Other', status: 'pending' }],
        source: 'tool',
        lastMessageAt: null
      })
    )
    expect(badge()).toBeNull()
  })

  it('shows the current goal’s mark instead of the count once its PRs are known', () => {
    render(
      <TooltipProvider>
        <SessionRowTodoBadge session={session} />
      </TooltipProvider>
    )
    act(() =>
      seedGoalsTodosDetailsForTests('row-1', {
        goal: null,
        todos: [{ text: 'Fix CI', status: 'current' }],
        source: 'tool',
        lastMessageAt: null,
        pullRequests: [
          { owner: 'acme', repo: 'site', number: 7, firstOrder: 1, lastOrder: 1, firstAt: 1 }
        ]
      })
    )
    // Not read yet: the to-do count stands in.
    expect(badge()?.textContent).toBe('0/1')
    act(() =>
      publishSessionPullRequestFactsForTest({
        owner: 'acme',
        repo: 'site',
        number: 7,
        title: 'fix: pricing table',
        url: 'https://github.com/acme/site/pull/7',
        state: 'open',
        approved: false,
        checks: 'failure',
        failingChecks: 1,
        baseBranch: 'prod-site',
        mergeCommit: null,
        mergedAt: null,
        settledAt: null,
        deploy: { workflows: ['Deploy'], status: null, url: null }
      })
    )
    expect(badge()).toBeNull()
    const mark = document.querySelector('[data-session-goal-badge]')
    expect(mark?.getAttribute('data-session-goal-badge')).toBe('fail')
  })
})
