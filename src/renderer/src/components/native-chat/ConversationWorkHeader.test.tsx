// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextActionChainFixture } from '@/components/next-action/next-action-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import { conversationViewKey } from '@/lib/conversation-view'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { ConversationWorkHeader } from './ConversationWorkHeader'
import { forgetWorkHeaderAutoExpands } from './use-work-header-collapse'

const PANE = 'term:tab-1:pane-1'
const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: PANE,
  kind: 'terminal',
  label: 'Advertising run 255',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const KEY = conversationViewKey(session)

const registry = vi.hoisted(() => ({
  chain: null as unknown,
  listeners: new Set<() => void>(),
  agentState: 'idle' as string,
  panel: null as unknown,
  queueSource: vi.fn()
}))
vi.mock('@/lib/session-chain-registry', () => ({
  useSessionChainForRow: () =>
    useSyncExternalStore(
      (listener) => {
        registry.listeners.add(listener)
        return () => registry.listeners.delete(listener)
      },
      () => registry.chain
    )
}))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [session]
}))
vi.mock('./session-work-owner', () => ({ sessionWorkOwner: () => session }))
vi.mock('./NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))
vi.mock('@/components/next-action/use-session-details-facts', () => ({
  useSessionDetailsFacts: () => ({ agent: { name: 'Codex', state: registry.agentState } })
}))
vi.mock('@/components/sidebar/routines/RoutineConversationHeader', () => ({
  RoutineConversationHeader: () => null
}))
vi.mock('@/components/session-activity/SessionActivityPanel', () => ({
  SessionActivityPanel: () => <p>Activity line and tasks</p>
}))
vi.mock('@/components/next-action/use-session-outputs', () => ({
  useSessionOutputs: ({ active }: { active: boolean }) => ({
    cards: [],
    liveness: new Map(),
    target: null,
    active
  })
}))
vi.mock('@/components/next-action/SessionFilesAndLinks', () => ({
  SessionFilesAndLinksView: ({ outputs }: { outputs: { active: boolean } }) => (
    <p data-files-links-active={String(outputs.active)}>Files and links list</p>
  )
}))
vi.mock('@/components/session-activity/ConversationContextDetails', () => ({
  ConversationContextDetails: () => <p>First recorded request</p>
}))
vi.mock('@/components/prompt-queue/PromptQueueStrip', () => ({
  PromptQueueStrip: ({ source }: { source: unknown }) => {
    registry.queueSource(source)
    return null
  }
}))
vi.mock('@/components/next-action/UpNextSubject', () => ({
  UpNextSubject: () => <section data-up-next-chain>{registry.panel as never}</section>
}))
vi.mock('@/components/next-action/advanced/SessionDetailsConnected', () => ({
  SessionDetailsConnected: ({
    sections
  }: {
    sections?: {
      activity?: React.ReactNode
      filesAndLinks?: React.ReactNode
      more?: React.ReactNode
    }
  }) => (
    <>
      <input aria-label="Session note" defaultValue="" />
      <div data-test-section="activity">{sections?.activity}</div>
      {sections?.filesAndLinks ? (
        <div data-test-section="files">{sections.filesAndLinks}</div>
      ) : null}
      <div data-test-section="more">{sections?.more}</div>
    </>
  )
}))

function publish(chain: SessionChain | null): void {
  act(() => {
    registry.chain = chain
    for (const listener of registry.listeners) {
      listener()
    }
  })
}

function setPaneState(state: string | null): void {
  act(() => {
    useAppStore.setState({
      agentStatusByPaneKey: state ? { [PANE]: { paneKey: PANE, state } } : {}
    } as never)
  })
}

function queued(chain: SessionChain, count: number): SessionChain {
  return {
    ...chain,
    steps: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      agent: 'claude' as const,
      prompt: 'Improve',
      presetId: 'improve' as const,
      status: 'queued' as const
    }))
  }
}

function blocked(chain: SessionChain, reason: string): SessionChain {
  return { ...chain, blocked: { paneKey: PANE, reason } }
}

const chevron = () => screen.getByRole('button', { name: 'Session context & outcome' })
const info = () => screen.getByRole('button', { name: 'Session details' })
const panel = () => document.querySelector('[data-work-header-panel]:not([hidden])')
const summary = () => document.querySelector('[data-work-header-summary]')
const stored = () => useSessionSidebarView.getState().view.workHeaderCollapsed?.[KEY]
const mount = () =>
  render(
    <TooltipProvider>
      <ConversationWorkHeader worktreeId="workspace" paneKey={PANE} tabId="term:tab-1" />
    </TooltipProvider>
  )

beforeEach(() => {
  session.hostId = 'local'
  registry.queueSource.mockClear()
  registry.chain = null
  registry.agentState = 'idle'
  registry.panel = null
  useSessionSidebarView.setState({ view: emptySessionSidebarView() })
  forgetWorkHeaderAutoExpands()
  setPaneState(null)
})
afterEach(() => {
  cleanup()
  setPaneState(null)
  session.hostId = 'local'
})

describe('conversation recovery visibility', () => {
  it('mounts the existing queue receipt for the locally owned conversation', () => {
    mount()
    expect(registry.queueSource).toHaveBeenCalledWith({
      worktreeId: session.worktreeId,
      paneKey: PANE,
      kind: 'pty'
    })
  })

  it('never reads a remote conversation queue through the local runtime', () => {
    session.hostId = 'ssh:remote-host'
    mount()
    expect(registry.queueSource).toHaveBeenCalledWith(null)
    expect(registry.queueSource.mock.calls.every(([source]) => source === null)).toBe(true)
  })
})

describe('default and manual fold', () => {
  it('starts with the two icon controls, Info and Outcome, both collapsed', () => {
    mount()
    expect(panel()).toBeNull()
    expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(0)
    // An unset outcome leaves no placeholder behind; the status alone speaks.
    expect(summary()!.textContent).toBe('idle · waiting for you')
    const controls = document.querySelector('[data-conversation-information-controls]')!
    const buttons = [...controls.querySelectorAll('button')]
    expect(
      buttons.map((button) => button.getAttribute('data-conversation-information-toggle'))
    ).toEqual(['details', 'outcome'])
    // Icon-only: the name lives in aria-label and the tooltip, never as visible text.
    expect(buttons.map((button) => button.textContent)).toEqual(['', ''])
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Session details',
      'Session context & outcome'
    ])
    expect(screen.queryByRole('button', { name: 'Work' })).toBeNull()
    expect(document.querySelector('[data-conversation-information-panel="work"]')).toBeNull()
    expect(info().getAttribute('aria-expanded')).toBe('false')
    expect(chevron().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron())
    expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(1)
    expect(panel()).toBeTruthy()
    expect(chevron().getAttribute('data-state')).toBe('open')
  })

  it('folds by default once an outcome or a chain exists, with the summary and Outcome control', () => {
    registry.chain = nextActionChainFixture()
    mount()
    expect(panel()).toBeNull()
    expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(0)
    expect(summary()!.textContent).toBe(
      'Verify signed IDE receipt handoff · 1 of 3 Done When · idle · waiting for you'
    )
    expect(summary()!.getAttribute('title')).toBe(summary()!.textContent)
    expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
    expect(chevron().getAttribute('aria-expanded')).toBe('false')
    const controls = chevron().getAttribute('aria-controls')!
    fireEvent.click(chevron())
    expect(panel()!.id).toBe(controls)
  })

  it('folds by default for a chain of queued steps without an outcome', () => {
    const { outcomeSet: _dropped, ...chainless } = nextActionChainFixture()
    registry.chain = queued(chainless, 1)
    mount()
    expect(panel()).toBeNull()
    expect(summary()!.textContent).toBe('then → ✨ Improve · Claude → Done')
  })

  it('toggles and persists; the saved choice wins over the default on remount', () => {
    mount()
    fireEvent.click(chevron())
    expect(panel()).toBeTruthy()
    expect(stored()).toBe(false)
    fireEvent.click(chevron())
    expect(panel()).toBeNull()
    expect(stored()).toBe(true)
    fireEvent.click(chevron())
    cleanup()
    registry.chain = nextActionChainFixture()
    mount()
    expect(panel()).toBeTruthy()
  })

  it('keeps the title row as a mouse shortcut to Outcome', () => {
    mount()
    fireEvent.click(summary()!)
    expect(panel()).toBeTruthy()
    fireEvent.click(document.querySelector('[data-work-header-label]')!)
    expect(panel()).toBeNull()
    expect(document.querySelector('[data-work-header-row]')!.getAttribute('tabindex')).toBe('-1')
  })

  it('Enter and Space on the focused chevron toggle and keep focus there', async () => {
    const user = userEvent.setup()
    mount()
    expect(chevron().tagName).toBe('BUTTON')
    chevron().focus()
    await user.keyboard('{Enter}')
    expect(panel()).toBeTruthy()
    expect(document.activeElement).toBe(chevron())
    await user.keyboard(' ')
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(chevron())
  })
})

describe('auto-fold', () => {
  it('T1: an outcome chosen while open folds the panel and focuses the chevron', () => {
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    expect(panel()).toBeTruthy()
    publish(nextActionChainFixture())
    expect(panel()).toBeNull()
    expect(stored()).toBe(true)
    expect(document.activeElement).toBe(chevron())
  })

  it('T1 from a chain that loads after mount folds but leaves a caret elsewhere alone', () => {
    const outside = document.createElement('textarea')
    document.body.appendChild(outside)
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    outside.focus()
    publish(nextActionChainFixture())
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('T1 edit: a saved reword of the outcome folds too', () => {
    const chain = nextActionChainFixture()
    registry.chain = chain
    useSessionSidebarView.getState().setWorkHeaderCollapsed(KEY, false)
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    expect(panel()).toBeTruthy()
    const reworded = structuredClone(chain)
    reworded.outcomeSet!.outcomes[0]!.title = 'Verified handoff'
    reworded.outcomeSet!.revision += 1
    publish(reworded)
    expect(panel()).toBeNull()
  })

  it('T2: a rising queued count folds; the same count republished does not', () => {
    const chain = nextActionChainFixture()
    registry.chain = chain
    useSessionSidebarView.getState().setWorkHeaderCollapsed(KEY, false)
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    publish(queued(chain, 2))
    expect(panel()).toBeNull()
    fireEvent.click(chevron())
    expect(panel()).toBeTruthy()
    publish(queued({ ...chain, updatedAt: 2 }, 2))
    expect(panel()).toBeTruthy()
  })

  it.each([
    ['an open outcome editor', <div key="e" data-next-action-outcome-editor />],
    ['a textarea', <textarea key="t" />],
    ['a draft row', <div key="d" data-up-next-block="draft" data-state="draft" />]
  ])('g1: T1 over %s stays open and writes nothing', (_name, surface) => {
    registry.panel = surface
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    publish(nextActionChainFixture())
    expect(panel()).toBeTruthy()
    expect(stored()).toBe(false)
  })

  it('g2: T2 while typing in the panel stays open', () => {
    registry.panel = <input key="i" type="text" aria-label="note" />
    const chain = nextActionChainFixture()
    registry.chain = chain
    useSessionSidebarView.getState().setWorkHeaderCollapsed(KEY, false)
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    screen.getByLabelText('note').focus()
    publish(queued(chain, 1))
    expect(panel()).toBeTruthy()
  })

  it('g3: T1 that arrives blocked stays open', () => {
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    publish(blocked(nextActionChainFixture(), 'prompt'))
    expect(panel()).toBeTruthy()
    expect(stored()).toBe(false)
  })

  it('never folds or opens on a state change that is not an outcome, a queue or an ask', () => {
    const chain = nextActionChainFixture()
    registry.chain = chain
    mount()
    expect(panel()).toBeNull()
    publish({ ...chain, state: 'launching' })
    expect(panel()).toBeNull()
    fireEvent.click(chevron())
    publish({ ...chain, state: 'done', updatedAt: 3 })
    expect(panel()).toBeTruthy()
  })
})

describe('auto-expand on needs you', () => {
  it('E1: a new ask opens once; the same ask again does not; a different ask does', () => {
    const chain = nextActionChainFixture()
    registry.chain = chain
    mount()
    expect(panel()).toBeNull()
    publish(blocked(chain, 'prompt'))
    expect(panel()).toBeTruthy()
    expect(summary()).toBeNull()
    fireEvent.click(chevron())
    publish(blocked({ ...chain, updatedAt: 2 }, 'prompt'))
    expect(panel()).toBeNull()
    publish(blocked(chain, 'interrupted'))
    expect(panel()).toBeTruthy()
  })

  it('E1 via pane status: the pane going blocked opens once', () => {
    registry.chain = nextActionChainFixture()
    mount()
    expect(panel()).toBeNull()
    setPaneState('blocked')
    expect(panel()).toBeTruthy()
    fireEvent.click(chevron())
    setPaneState('working')
    setPaneState('blocked')
    expect(panel()).toBeNull()
  })
})

describe('summary per state', () => {
  it('says idle with no chain', () => {
    useSessionSidebarView.getState().setWorkHeaderCollapsed(KEY, true)
    mount()
    expect(summary()!.textContent).toBe('idle · waiting for you')
    expect(summary()!.getAttribute('data-work-header-summary')).toBe('idle')
  })

  it('names what is queued after the outcome and its proof', () => {
    registry.chain = queued(nextActionChainFixture(), 2)
    mount()
    expect(summary()!.textContent).toBe(
      'Verify signed IDE receipt handoff · 1 of 3 Done When · then → ✨ Improve · Claude → ✨ Improve · Claude → Done'
    )
  })

  it('says needs you with the reason, in the asking colour', () => {
    registry.chain = blocked(nextActionChainFixture(), 'prompt')
    mount()
    expect(summary()!.textContent).toBe(
      'Verify signed IDE receipt handoff · 1 of 3 Done When · needs you · Needs your answer · the plan carries on after'
    )
    expect(summary()!.className).toContain('text-agent-question-text')
    expect(summary()!.getAttribute('data-work-header-summary')).toBe('needs-you')
  })

  it('says closed and working from the agent facts', () => {
    registry.chain = nextActionChainFixture()
    registry.agentState = 'closed'
    mount()
    expect(summary()!.textContent).toMatch(/· closed$/)
    cleanup()
    registry.agentState = 'running'
    mount()
    expect(summary()!.textContent).toMatch(/· working$/)
  })

  it('repaints from a commit made in the strip popover while staying folded', () => {
    const chain = nextActionChainFixture()
    registry.chain = chain
    mount()
    publish(queued(chain, 1))
    expect(panel()).toBeNull()
    expect(summary()!.textContent).toContain('then → ✨ Improve · Claude')
  })
})

describe('Escape inside the open panel (brief 78 #8)', () => {
  it('off a text field: folds, persists, and puts focus on the chevron', () => {
    registry.panel = (
      <>
        <button key="r" type="button" data-up-next-row="draft:1">
          row
        </button>
        <textarea key="t" aria-label="Prompt text" />
      </>
    )
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    const row = screen.getByRole('button', { name: 'row' })
    row.focus()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(panel()).toBeNull()
    expect(stored()).toBe(true)
    expect(document.activeElement).toBe(chevron())
  })

  it('in a text field: the field keeps its Escape and the panel stays open', () => {
    registry.panel = <textarea key="t" aria-label="Prompt text" />
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    const field = screen.getByLabelText('Prompt text')
    field.focus()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(panel()).toBeTruthy()
    expect(stored()).toBe(false)
    expect(document.activeElement).toBe(field)
  })

  it('already answered by something else: does nothing', () => {
    registry.panel = (
      <button key="r" type="button" data-up-next-row="draft:1">
        row
      </button>
    )
    mount()
    if (!panel()) {
      fireEvent.click(chevron())
    }
    const row = screen.getByRole('button', { name: 'row' })
    row.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(panel()).toBeTruthy()
    // Any other key on a row is not a fold either.
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(panel()).toBeTruthy()
  })
})

describe('information disclosures preserve the working surfaces', () => {
  it('retains unsaved outcome and session fields while switching panels', () => {
    registry.panel = <textarea aria-label="Unsaved outcome" defaultValue="" />
    mount()
    fireEvent.click(chevron())
    const outcome = screen.getByLabelText('Unsaved outcome') as HTMLTextAreaElement
    fireEvent.change(outcome, { target: { value: 'Keep the complete goal' } })
    fireEvent.click(info())
    expect(panel()).toBeNull()
    const note = screen.getByLabelText('Session note') as HTMLInputElement
    fireEvent.change(note, { target: { value: 'Keep session context' } })
    fireEvent.click(chevron())
    expect(note.closest('[hidden]')).toBeTruthy()
    expect(screen.getByLabelText('Unsaved outcome')).toBe(outcome)
    expect(outcome.value).toBe('Keep the complete goal')
    fireEvent.click(info())
    expect(screen.getByLabelText('Session note')).toBe(note)
    expect(note.value).toBe('Keep session context')
  })

  it('Info holds the facts, the activity, the files and links, then the context in More', () => {
    mount()
    fireEvent.click(info())
    const details = document.querySelector('[data-conversation-information-panel="details"]')!
    expect(details.hasAttribute('hidden')).toBe(false)
    expect(details.querySelector('[data-test-section="activity"]')!.textContent).toBe(
      'Activity line and tasks'
    )
    expect(details.querySelector('[data-test-section="more"]')!.textContent).toBe(
      'First recorded request'
    )
    expect(details.querySelector('[data-test-section="files"]')!.textContent).toBe(
      'Files and links list'
    )
    // The list re-checks files and servers only while Info is the open panel.
    expect(
      details.querySelector('[data-files-links-active]')!.getAttribute('data-files-links-active')
    ).toBe('true')
    fireEvent.click(chevron())
    expect(
      details.querySelector('[data-files-links-active]')!.getAttribute('data-files-links-active')
    ).toBe('false')
  })

  it('opens a new ask over Info, then closes to the conversation without losing Info', () => {
    registry.chain = nextActionChainFixture()
    mount()
    fireEvent.click(info())
    publish(blocked(registry.chain as SessionChain, 'prompt'))
    expect(panel()).toBeTruthy()
    expect(info().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron())
    expect(
      document.querySelectorAll('[data-conversation-information-panel]:not([hidden])')
    ).toHaveLength(0)
    fireEvent.click(info())
    expect(screen.getByText('Activity line and tasks').closest('[hidden]')).toBeNull()
  })

  it('Escape on the Info surface closes only that panel and restores its button focus', () => {
    mount()
    fireEvent.click(info())
    const content = document.querySelector('[data-conversation-information-panel="details"]')!
    fireEvent.keyDown(content, { key: 'Escape' })
    expect(content.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(info())
  })
})
