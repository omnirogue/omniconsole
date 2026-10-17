// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { conversationViewKey } from '@/lib/conversation-view'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { defaultSessionTags } from '@/lib/session-tags'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { SessionSidebarRow } from './SessionSidebarRow'

/**
 * Why this test exists: Sal reported that tags made his list unreadable — a tagged session took
 * two lines where an untagged one took one. A compact row shows its tags as colour alone, on the
 * name's line; the names stay in the title and the tag picker.
 */
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

function tagTheSession(ids: string[]): void {
  useSessionTags.setState({
    data: { ...defaultSessionTags(), assignments: { [conversationViewKey(session)]: ids } },
    scope: 'test',
    loaded: true,
    error: null
  })
}

function renderRow(): void {
  render(
    <TooltipProvider>
      <SessionSidebarRow
        session={session}
        current={false}
        queued={false}
        onOpen={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
}

const dots = () => [...document.querySelectorAll('[data-session-tag-dot]')]
const rowLine = () => document.querySelector('[data-session-row-line]')

describe('a compact session row with tags', () => {
  beforeEach(() => {
    useSessionSidebarView.setState({ view: emptySessionSidebarView() })
  })
  afterEach(() => {
    cleanup()
    useSessionTags.setState({ data: defaultSessionTags(), loaded: false, error: null, scope: null })
  })

  it('shows each tag as a colour on the name line and never as text', () => {
    tagTheSession(['omnirogue'])
    renderRow()
    const [dot] = dots()
    expect(dot).toBeTruthy()
    expect(dot.getAttribute('aria-label')).toBe('OmniRogue')
    expect(dot.textContent).toBe('')
    expect(rowLine()?.contains(dot)).toBe(true)
    expect(screen.queryByText('OmniRogue')).toBeNull()
  })

  it('collapses more tags than fit into a count, so the row keeps one line', () => {
    tagTheSession(['omnirogue', 'betacorp', 'acme', 'omnios'])
    renderRow()
    expect(dots()).toHaveLength(3)
    expect(screen.getByText('+1')).toBeTruthy()
    expect(document.querySelector('[data-session-tag-dots]')?.getAttribute('title')).toBe(
      'OmniRogue, BetaCorp, ACME, OmniOS'
    )
  })

  it('leaves an untagged row with no tag marks at all', () => {
    tagTheSession([])
    renderRow()
    expect(dots()).toHaveLength(0)
    expect(document.querySelector('[data-session-tag-dots]')).toBeNull()
  })
})
