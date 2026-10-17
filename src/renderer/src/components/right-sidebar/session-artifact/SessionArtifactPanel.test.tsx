// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionPanelItem } from './session-panel-items'

const state = vi.hoisted(() => ({
  session: null as SidebarSession | null,
  cards: [] as unknown[],
  nextSteps: 0 as number | null,
  workLog: true,
  waits: 0
}))

vi.mock('./use-on-screen-sidebar-session', () => ({
  useOnScreenSidebarSession: () => state.session
}))
vi.mock('@/components/next-action/use-session-outputs', () => ({
  useSessionOutputs: () => ({
    cards: state.cards,
    liveness: new Map(),
    target: { worktreeId: 'w' }
  })
}))
vi.mock('@/components/next-steps/next-steps-pending-store', () => ({
  usePendingNextStepCount: () => state.nextSteps
}))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: () => ({ worktreeId: 'w', paneKey: 'tab:leaf' })
}))
vi.mock('@/lib/session-files-and-links-actions', () => ({ sessionFileContext: () => ({}) }))
vi.mock('./session-panel-transcript', () => ({ useSessionPanelTranscript: () => [] }))
vi.mock('./use-session-written-files', () => ({ useSessionWrittenFiles: () => [] }))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
vi.mock('./session-waits-model', () => ({
  sessionWaitsModel: () =>
    state.waits > 0 ? { waits: Array.from({ length: state.waits }), after: [], finish: null } : null
}))
vi.mock('./use-session-work-log-available', () => ({
  useSessionWorkLogAvailable: (session: unknown) => session !== null && state.workLog
}))
vi.mock('./SessionDocumentTab', () => ({
  SessionDocumentTab: ({ items }: { items: SessionPanelItem[] }) => (
    <p data-testid="document">{items.map((item) => item.key).join(',')}</p>
  )
}))
vi.mock('./SessionFilesTab', () => ({
  SessionFilesTab: ({ links }: { links: { key: string }[] }) => (
    <p data-testid="files">{links.map((link) => link.key).join(',')}</p>
  )
}))
vi.mock('./SessionWorkLog', () => ({ SessionWorkLog: () => <p data-testid="work-log" /> }))
vi.mock('./SessionNextSteps', () => ({ SessionNextSteps: () => <p data-testid="next-steps" /> }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { SessionArtifactPanel } from './SessionArtifactPanel'
import { requestSessionPanelView, useSessionPanelViewRequest } from './session-panel-view-request'

const page: SessionPanelItem = {
  kind: 'artifact',
  key: 'artifact:plan-page',
  at: 2,
  record: {
    slug: 'plan-page',
    shareUrl: 'https://omnios.example/a/plan-page',
    sourceKey: '',
    savedAt: 2,
    contentUrl: '',
    origin: null
  }
}
const plan: SessionPanelItem = { kind: 'slite', key: 'slite:doc1', at: 1, id: 'doc1', url: '' }
const session = {
  rowKey: 'row',
  worktreeId: 'w',
  hostId: 'local',
  label: 'Build'
} as SidebarSession

function panel(artifacts: SessionPanelItem[], pickedKey: string | null = null, revision = 0) {
  return (
    <SessionArtifactPanel
      artifacts={artifacts}
      visible
      pickedKey={pickedKey}
      onPick={vi.fn()}
      selectionRevision={revision}
    />
  )
}

const tabNames = () => screen.queryAllByRole('button').map((button) => button.textContent)

beforeEach(() => {
  state.session = session
  state.cards = []
  state.nextSteps = 0
  state.workLog = true
  state.waits = 0
  useSessionPanelViewRequest.setState({ view: null, revision: 0 })
})
afterEach(() => cleanup())

describe('SessionArtifactPanel', () => {
  it('shows only tabs with content, always in the same order, opening on the first', () => {
    state.cards = [
      { type: 'file', key: 'file:/w/a.md', path: '/w/a.md', name: 'a.md', location: '' }
    ]
    render(panel([plan, page]))
    expect(tabNames()).toEqual(['OmniOS', 'Plan', 'Files & links', 'Work log'])
    expect(screen.getByTestId('document').textContent).toBe('artifact:plan-page')
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByTestId('document').textContent).toBe('slite:doc1')
    fireEvent.click(screen.getByRole('button', { name: 'Work log' }))
    expect(screen.getByTestId('work-log')).toBeTruthy()
  })

  it('does not repeat a page that has its own tab among the Files links', () => {
    state.cards = [
      { type: 'link', key: 'link:page', url: 'https://omnios.example/a/plan-page/' },
      { type: 'pull-request', key: 'pr:7', url: 'https://github.com/o/r/pull/7' }
    ]
    render(panel([page]))
    fireEvent.click(screen.getByRole('button', { name: 'Files & links' }))
    expect(screen.getByTestId('files').textContent).toBe('pr:7')
  })

  it('draws one quiet line, no tab bar, when the session has nothing to show', () => {
    state.session = null
    render(panel([]))
    expect(tabNames()).toEqual([])
    expect(screen.getByText('Nothing from this session yet.')).toBeTruthy()
  })

  it('gives a session known only from its launch no Work log, just the quiet line', () => {
    state.workLog = false
    render(panel([]))
    expect(tabNames()).toEqual([])
    expect(screen.getByText('Nothing from this session yet.')).toBeTruthy()
  })

  it('opens on the clicked document’s tab when a link click mounts it', () => {
    render(panel([page, plan], plan.key, 3))
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('document').textContent).toBe('slite:doc1')
    fireEvent.click(screen.getByRole('button', { name: 'OmniOS' }))
    expect(screen.getByTestId('document').textContent).toBe('artifact:plan-page')
  })

  it('says so quietly while no conversation is on screen, never falling back to Explorer', () => {
    state.session = null
    render(
      <SessionArtifactPanel
        artifacts={[]}
        onScreen={false}
        visible
        pickedKey={null}
        onPick={vi.fn()}
        selectionRevision={0}
      />
    )
    expect(tabNames()).toEqual([])
    expect(screen.getByText('Open a conversation to see its work here.')).toBeTruthy()
  })

  it('offers Next steps only while there are some, or when the terminal card asked', () => {
    render(panel([]))
    expect(tabNames()).toEqual(['Work log'])
    act(() => requestSessionPanelView('next-steps'))
    expect(tabNames()).toEqual(['Work log', 'Next steps'])
    expect(screen.getByTestId('next-steps')).toBeTruthy()
    expect(useSessionPanelViewRequest.getState().view).toBeNull()
  })

  it('offers Next steps while the session waits on someone, even with no suggestion', () => {
    state.waits = 1
    render(panel([]))
    expect(tabNames()).toEqual(['Work log', 'Next steps'])
  })

  it('switches to the tab holding a document the person clicked in the conversation', () => {
    const { rerender } = render(panel([page, plan]))
    expect(screen.getByTestId('document').textContent).toBe('artifact:plan-page')
    rerender(panel([page, plan], plan.key, 1))
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true')
  })
})
