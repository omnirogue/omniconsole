// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LocalWorkflowTabStatus } from '@/lib/local-workflow-tab-status'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionSidebarRow } from './SessionSidebarRow'

/**
 * Why these tests exist: in live acceptance a finished Council row showed a plain terminal glyph,
 * done and failed runs were hard to tell apart, and the name got 0 px beside invisible buttons.
 * A workflow row now shows its own state and preset, and hover-only controls take no width.
 */
vi.mock('./SessionRowHoverCard', () => ({
  SessionRowHoverCard: ({ children }: { children: React.ReactNode }) => children
}))

function workflowSession(status: LocalWorkflowTabStatus): SidebarSession {
  return {
    rowKey: 'row-1',
    sessionKey: 'session-1',
    worktreeId: 'repo:/workspace',
    hostId: 'local',
    tabId: 'term:tab-1',
    paneKey: null,
    kind: 'terminal',
    label: 'What are the riskiest defects in this service?',
    workspaceLabel: 'Reserve app',
    agent: 'Council',
    unavailable: false,
    folderKeyMigration: null,
    workflow: { preset: 'council', status }
  }
}

function renderRow(
  status: LocalWorkflowTabStatus,
  overrides: Partial<ComponentProps<typeof SessionSidebarRow>> = {}
) {
  render(
    <TooltipProvider>
      <SessionSidebarRow
        session={workflowSession(status)}
        current={false}
        queued={false}
        onOpen={vi.fn()}
        onCancelQueue={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
}

const stateGlyph = () => document.querySelector('[data-workflow-row-state]') as HTMLElement

beforeEach(() => {
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})
afterEach(cleanup)

describe('workflow rows', () => {
  it('shows done, failed and stopped with different glyphs and colours, never a terminal', () => {
    const seen = new Map<string, string>()
    for (const status of ['done', 'failed', 'stopped'] as const) {
      renderRow(status, { pursuitState: status === 'stopped' ? 'interrupted' : status })
      const glyph = stateGlyph()
      expect(glyph.getAttribute('data-workflow-row-state')).toBe(status)
      expect(document.querySelector('[data-conversation-surface="terminal"]')).toBeNull()
      seen.set(status, glyph.innerHTML)
      cleanup()
    }
    expect(new Set(seen.values()).size).toBe(3)
    expect(seen.get('done')).toContain('text-status-success')
    expect(seen.get('failed')).toContain('text-destructive')
    expect(seen.get('stopped')).toContain('text-muted-foreground')
  })

  it('names the state for assistive tech and keeps the preset icon beside it', () => {
    renderRow('failed', { pursuitState: 'failed' })
    expect(screen.getByRole('img', { name: 'Failed' })).toBe(stateGlyph())
    expect(stateGlyph().nextElementSibling?.tagName.toLowerCase()).toBe('svg')
  })

  it('keeps as much of the name on hover as any other row, beside its second glyph', () => {
    renderRow('done', { pursuitState: 'done' })
    const open = screen.getByRole('button', { name: /^Open session What are the riskiest/ })
    const classes = open.className.split(' ')
    // Why: the preset glyph and its gap (1.125rem) came out of the name's floor, leaving "Fix t…".
    expect(classes).toContain('[--row-name-floor:9.625rem]')
    // Why: the preset glyph is a bare svg, which took the Button's wider icon padding and
    // indented a workflow row 4 px further than the rows around it.
    expect(classes).toContain('has-[>svg]:px-2')
    expect(classes).not.toContain('has-[>svg]:px-3')
  })

  it('gives the name the row: no hover-only control takes width at rest', () => {
    // Comfortable: each hover-only group folds by itself (compact folds the whole cluster).
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), density: 'comfortable' }
    })
    renderRow('done', { pursuitState: 'done' })
    const open = screen.getByRole('button', { name: /^Open session What are the riskiest/ })
    expect(open.textContent).toContain('What are the riskiest defects in this service?')
    const cluster = document.querySelector('[data-session-row-cluster]') as HTMLElement
    const folded = [...cluster.querySelectorAll<HTMLElement>('span')].filter((span) =>
      span.className.split(' ').includes('can-hover:max-w-0')
    )
    expect(folded.length).toBeGreaterThan(0)
    for (const button of cluster.querySelectorAll('button')) {
      // Every control sits inside a folded group, so none keeps width while invisible.
      expect(
        folded.some((span) => span.contains(button)),
        button.getAttribute('aria-label') ?? ''
      ).toBe(true)
    }
  })

  it('keeps the name after a click: only focus inside the controls, or keyboard focus, opens them', () => {
    // Why: opening a workflow row has no pane to take focus, so the clicked Open button keeps it.
    // Controls that opened for any focus in the row squeezed the name back to 0 px.
    renderRow('done', { pursuitState: 'done' })
    const open = screen.getByRole('button', { name: /^Open session What are the riskiest/ })
    open.focus()
    expect(document.activeElement).toBe(open)
    const cluster = document.querySelector('[data-session-row-cluster]') as HTMLElement
    const folded = [...cluster.querySelectorAll<HTMLElement>('span')].filter((span) =>
      span.className.split(' ').includes('can-hover:max-w-0')
    )
    expect(folded.length).toBeGreaterThan(0)
    for (const span of folded) {
      const classes = span.className.split(' ')
      expect(classes.filter((name) => name.startsWith('group-focus-within:'))).toEqual([])
      // Tab into a folded control still opens its group, and keyboard focus on the row does too
      // (a mouse click on a button is not :focus-visible; the rename field is not a button).
      expect(classes).toContain('focus-within:max-w-none')
      expect(classes).toContain('group-has-[button:focus-visible]:max-w-none')
    }
  })
})
