// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddNextButton } from '@/components/next-step/AddNextButton'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpNextControls } from '@/components/next-action/UpNextControls'
import { UpNextPopover } from './UpNextPopover'
import { UpNextSubject } from './UpNextSubject'
import type { NextStepSubject } from '@/components/next-step/next-step-subject'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { UpNextChainProps } from './UpNextChain'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

const mounted = vi.hoisted(() => ({
  props: [] as unknown[],
  sources: [] as unknown[],
  commit: vi.fn(async () => true),
  append: vi.fn()
}))
vi.mock('./use-up-next', () => ({
  useUpNext: (source: unknown, _error: unknown, surface: unknown) => {
    mounted.sources.push({ source, surface })
    return { commit: mounted.commit, append: mounted.append }
  }
}))
vi.mock('./UpNextChain', () => ({
  UpNextChainView: ({ controller }: { controller: { commit: () => Promise<boolean> } }) => (
    <button data-up-next-chain onClick={() => void controller.commit()}>
      Commit
    </button>
  ),
  UpNextChain: (props: UpNextChainProps) => {
    mounted.props.push(props)
    return <section data-up-next-chain />
  }
}))
vi.mock('./OutcomeLine', () => ({ OutcomeLine: () => null }))
vi.mock('./advanced/SessionDetailsConnected', () => ({
  SessionDetailsConnected: () => <button>Runs on ▾</button>
}))
vi.mock('./use-session-details-facts', () => ({
  // No `runsOn`: the paired-host status line below falls back to the host id without it.
  useSessionDetailsFacts: () => ({
    agent: { name: 'Claude' },
    workspace: '/Users/maintainer/Work/OmniAgentOS/Prototypes/omni-ide · refs/heads/main-next',
    task: null
  })
}))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
afterEach(() => {
  cleanup()
  mounted.props = []
  mounted.sources = []
  vi.clearAllMocks()
})
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Conversation',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}
it('passes the same source adapter to the shared component for Chat and Terminal sessions', () => {
  for (const kind of ['terminal', 'structured'] as const) {
    const addressed = {
      ...session,
      kind,
      ...(kind === 'structured'
        ? { tabId: structuredAgentSessionTabId('native-a'), paneKey: null }
        : {})
    }
    render(<UpNextSubject subject={{ kind: 'session', session: addressed }} />)
    expect(mounted.props.at(-1)).toEqual({ source: conversationSourceForSession(addressed) })
    expect(conversationSourceForSession(addressed)).not.toBeNull()
    expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(1)
    cleanup()
  }
})
it('uses the identical composer on unstarted inbox threads and cards without inventing an address', () => {
  for (const subject of [
    { kind: 'thread', detail: { thread: { id: 'thread' } } },
    { kind: 'card', item: { task_id: 'task' } }
  ] as NextStepSubject[]) {
    render(<UpNextSubject subject={subject} />)
    expect(mounted.sources.at(-1)).toEqual({
      source:
        subject.kind === 'thread'
          ? { kind: 'thread', threadId: 'thread' }
          : { kind: 'card', taskId: 'task' },
      surface: expect.objectContaining({
        start: expect.any(Function),
        createCard: expect.any(Function)
      })
    })
    expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(1)
    cleanup()
  }
})
it('does not substitute a local conversation for a remote execution owner', () => {
  render(
    <UpNextSubject subject={{ kind: 'session', session: { ...session, hostId: 'ssh:server' } }} />
  )
  expect(mounted.props).toHaveLength(0)
  expect(screen.getByRole('status').textContent).toContain('ssh:server')
  expect(screen.queryByText('Open a conversation to configure Up next.')).toBeNull()
})

it.each(['terminal', 'structured'] as const)(
  'routes paired %s Next controls to their execution owner',
  (kind) => {
    const addressed: SidebarSession = {
      ...session,
      kind,
      hostId: 'runtime:host-a',
      ...(kind === 'structured'
        ? { tabId: structuredAgentSessionTabId('native-a'), paneKey: null }
        : {})
    }
    render(<UpNextSubject subject={{ kind: 'session', session: addressed }} />)
    expect(mounted.props.at(-1)).toEqual({
      source: conversationSourceForSession(addressed, 'runtime:host-a'),
      owner: { kind: 'environment', environmentId: 'host-a' }
    })
    expect(conversationSourceForSession(addressed)).toBeNull()
    expect(conversationSourceForSession(addressed, 'runtime:host-a')).not.toBeNull()
  }
)

/**
 * Brief 78 #3 changed this deliberately: Session details fold to one facts line above the chain,
 * so the split exists only while the card is open. Folded, the chain has the whole width.
 */
it('splits chain and Session details by the COMPOSER’s width, only while the card is open', () => {
  render(<UpNextSubject subject={{ kind: 'session', session }} />)
  const grid = document.querySelector('[data-up-next-chain]')!.parentElement!
  expect(grid.className).not.toContain('@min-[50rem]/composer:grid-cols-[minmax(0,1fr)_280px]')
  expect(grid.className).toContain('min-w-0')
  expect(grid.parentElement!.className).toContain('@container/composer')
  fireEvent.click(screen.getByRole('button', { name: /^Details/ }))
  // Why: the same composer mounts in a 48rem popover and in chat panes of any width; a
  // viewport `md:` split kept a 280px side card beside a squeezed chain in both.
  expect(grid.className).toContain('@min-[50rem]/composer:grid-cols-[minmax(0,1fr)_280px]')
  expect(grid.className).not.toMatch(/(^|\s)md:/)
  expect(document.querySelectorAll('[data-up-next-chain]')).toHaveLength(1)
})

/** Was "shows Runs on at mount": the card, Runs on included, is one disclosure away (brief 78 #3). */
it('folds Session details to one facts line, and the Details disclosure opens the full card', () => {
  render(<UpNextSubject subject={{ kind: 'session', session }} />)
  const line = document.querySelector('[data-next-action-facts-line]')!
  expect(line.textContent).toContain('Claude · …/omni-ide · refs/heads/main-next · Task: none')
  expect(line.querySelector('span')!.getAttribute('title')).toBe(
    'Claude · /Users/maintainer/Work/OmniAgentOS/Prototypes/omni-ide · refs/heads/main-next · Task: none'
  )
  expect(screen.queryByRole('button', { name: 'Runs on ▾' })).toBeNull()
  expect(screen.queryByText('Session details')).toBeNull()
  const toggle = screen.getByRole('button', { name: /^Details/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const runsOn = screen.getByRole('button', { name: 'Runs on ▾' })
  expect(runsOn.closest('details')).toBeNull()
  expect(screen.getAllByText('Session details')).toHaveLength(1)
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(
    runsOn.closest('[data-next-action-session-details-card]')
  )
  fireEvent.click(toggle)
  expect(screen.queryByRole('button', { name: 'Runs on ▾' })).toBeNull()
})
it('refreshes a thread after a successful commit, but not after refusal', async () => {
  const onChanged = vi.fn()
  render(
    <UpNextSubject
      subject={{ kind: 'thread', detail: { thread: { id: 'thread' } } } as NextStepSubject}
      onChanged={onChanged}
    />
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onChanged).toHaveBeenCalledOnce()
  mounted.commit.mockResolvedValueOnce(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onChanged).toHaveBeenCalledOnce()
})
it('opening and closing the Done trigger never appends a draft', () => {
  render(<UpNextPopover subject={{ kind: 'session', session }} done />)
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  // Was "Runs on ▾": the composer's presence is now read from its facts line (brief 78 #3).
  expect(document.querySelector('[data-next-action-facts-line]')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(document.querySelector('[data-next-action-facts-line]')).toBeNull()
  expect(mounted.append).not.toHaveBeenCalled()
})

/**
 * Why these exist: every card/Needs-you mount hands the composer a refresh callback, and the
 * popover used to drop it (`onSent: _onSent`), so a row kept its pre-commit card and the next
 * Done carried a stale revision.
 */
it('refreshes the card a popover mount was opened from, but not after a refusal', async () => {
  const onChanged = vi.fn()
  render(
    <UpNextPopover
      subject={{ kind: 'card', item: { task_id: 'task' } } as NextStepSubject}
      onChanged={onChanged}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onChanged).toHaveBeenCalledOnce()
  mounted.commit.mockResolvedValueOnce(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onChanged).toHaveBeenCalledOnce()
})
it('carries AddNextButton’s onSent through to the committed chain', async () => {
  const onSent = vi.fn()
  render(
    <AddNextButton
      subject={{ kind: 'card', item: { task_id: 'task' } } as NextStepSubject}
      onSent={onSent}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onSent).toHaveBeenCalledOnce()
})
it('carries the UpNextControls wrapper’s onChanged through to the committed chain', async () => {
  const onChanged = vi.fn()
  render(
    <UpNextControls
      subject={{ kind: 'card', item: { task_id: 'task' } } as NextStepSubject}
      onChanged={onChanged}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit' })))
  expect(onChanged).toHaveBeenCalledOnce()
})

/**
 * Why: the NA-3 retirement kept the legacy next-step finish door on this mount "until round 4",
 * and round 4 landed a Done that really finishes inside the composer. Every mount — rail rows
 * included — must now reach finish only through the composer.
 */
it('mounts no legacy next-step finish door beside the composer', () => {
  // The retired door lived inside a Tooltip, so the provider is here to let it render if it came
  // back: without it this assertion would pass on a throw instead of on an absent door.
  render(
    <TooltipProvider>
      <UpNextControls subject={{ kind: 'card', item: { task_id: 'task' } } as NextStepSubject} />
    </TooltipProvider>
  )
  expect(document.querySelector('[data-next-step-control="done"]')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
})
