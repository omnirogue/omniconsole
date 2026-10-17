// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { SessionAgentTemplateFact } from './SessionAgentTemplateFact'
import { recordedSessionAgentTemplate } from '@/lib/session-agent-template-record'

const actions = vi.hoisted(() => ({
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn(),
  requestEditTemplate: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: typeof actions) => unknown) => select(actions)
}))
vi.mock('@/components/sidebar/session-folders/new-conversation/launch-context', () => ({
  useLaunchContext: (select: (state: typeof actions) => unknown) => select(actions)
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const record = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }

describe('recordedSessionAgentTemplate', () => {
  const terminal = {
    id: 'tab-1',
    worktreeId: 'w',
    launchAgent: 'claude',
    agentTemplate: record
  } as TerminalTab
  const structured = {
    id: 'structured-agent-session-s1',
    worktreeId: 'w',
    contentType: 'agent-session',
    agentTemplate: record
  } as Tab
  const state = {
    tabsByWorktree: { w: [terminal] },
    unifiedTabsByWorktree: { w: [structured] },
    terminalLayoutsByTabId: {}
  }
  const split = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: '11111111-1111-4111-8111-111111111111' },
      second: { type: 'leaf' as const, leafId: '22222222-2222-4222-8222-222222222222' }
    },
    activeLeafId: null,
    expandedLeafId: null
  }

  it('reads a terminal session from its terminal tab', () => {
    expect(
      recordedSessionAgentTemplate(state, { kind: 'terminal', tabId: 'tab-1', worktreeId: 'w' })
    ).toBe(record)
  })

  it('reads a structured chat from its agent-session tab', () => {
    expect(
      recordedSessionAgentTemplate(state, {
        kind: 'structured',
        tabId: 'structured-agent-session-s1',
        worktreeId: 'w'
      })
    ).toBe(record)
  })

  it('speaks for no pane of a split tab', () => {
    expect(
      recordedSessionAgentTemplate(
        { ...state, terminalLayoutsByTabId: { 'tab-1': split } },
        { kind: 'terminal', tabId: 'tab-1', worktreeId: 'w' }
      )
    ).toBeUndefined()
  })

  it('stops speaking for the tab once its launched agent exited', () => {
    const exited = { ...terminal, launchAgent: undefined }
    expect(
      recordedSessionAgentTemplate(
        { ...state, tabsByWorktree: { w: [exited] } },
        { kind: 'terminal', tabId: 'tab-1', worktreeId: 'w' }
      )
    ).toBeUndefined()
  })

  it('has no record for an unknown tab or a tabless row', () => {
    expect(
      recordedSessionAgentTemplate(state, { kind: 'terminal', tabId: 'other', worktreeId: 'w' })
    ).toBeUndefined()
    expect(
      recordedSessionAgentTemplate(state, { kind: 'terminal', tabId: null, worktreeId: 'w' })
    ).toBeUndefined()
  })
})

describe('SessionAgentTemplateFact', () => {
  it('names the template and opens Settings › Agents on it', () => {
    render(
      <SessionAgentTemplateFact
        template={{ state: 'current', id: 'advertising', name: 'Advertising' }}
      />
    )
    const row = document.querySelector('[data-next-action-fact="agent-template"]')!
    expect(row.textContent).toContain('Agent')
    expect(row.querySelector('[data-agent-template-name]')?.textContent).toBe('Advertising')
    expect(row.querySelector('[data-agent-template-changed]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit instructions…' }))
    expect(actions.requestEditTemplate).toHaveBeenCalledWith('advertising')
    expect(actions.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'agents',
      repoId: null,
      sectionId: 'agent-templates'
    })
    expect(actions.openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('reads Default only when Default was recorded, with nothing to edit', () => {
    render(<SessionAgentTemplateFact template={{ state: 'default' }} />)
    expect(document.querySelector('[data-agent-template-name]')?.textContent).toBe('Default')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads Not recorded when the launch said nothing', () => {
    render(<SessionAgentTemplateFact template={{ state: 'unrecorded' }} />)
    const name = document.querySelector('[data-agent-template-name]')!
    expect(name.textContent).toBe('Not recorded')
    expect(name.className).toContain('text-muted-foreground')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('notes changed instructions', () => {
    render(
      <SessionAgentTemplateFact
        template={{ state: 'changed', id: 'advertising', name: 'Advertising' }}
      />
    )
    expect(document.querySelector('[data-agent-template-changed]')?.textContent).toBe(
      'Instructions changed since this session started'
    )
  })

  it('marks a removed template and offers nothing to edit', () => {
    render(
      <SessionAgentTemplateFact
        template={{ state: 'removed', id: 'advertising', name: 'Advertising' }}
      />
    )
    const name = document.querySelector('[data-agent-template-name]')!
    expect(name.textContent).toBe('Advertising')
    expect(name.getAttribute('title')).toBe('Advertising')
    expect(document.querySelector('[data-agent-template-removed]')?.textContent).toBe('(removed)')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
