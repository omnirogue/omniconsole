/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOVER_OPEN_DELAY_MS } from '@/components/next-step/use-hover-open-popover'
import { NewConversationButton } from './NewConversationButton'
import { HOVER_REARM_QUIET_MS } from './new-conversation/use-hover-rearm-on-move'

// Why (measured live on c39b7cf81): after a successful "+" launch the sidebar
// gained a new conversation row, but the main view stayed on Work home (no
// reveal), and the hover-opened menu stayed open because the pointer never
// left "+" (no pointerLeave to trigger a real close). Both are exercised here
// against the real NewConversationButton + useConversationLaunch wiring.

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  company: vi.fn(),
  createWorkflow: vi.fn(),
  openBuildReviewDialog: vi.fn(),
  activeWorktreeId: 'worktree-1' as string | null,
  target: { kind: 'local' } as { kind: string } | undefined,
  targetKey: 'local' as string | undefined,
  activateAndReveal: vi.fn(),
  activateTabAndFocusPane: vi.fn()
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.company,
  createCompanySessionFolder: vi.fn()
}))
vi.mock('@/lib/local-workflow-conversation', () => ({
  createLocalWorkflowConversation: mocks.createWorkflow
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndReveal
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (
      selector: (state: {
        activeWorktreeId: string | null
        settings: Record<string, unknown>
      }) => unknown
    ) => selector({ activeWorktreeId: mocks.activeWorktreeId, settings: {} }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({
        activeWorktreeId: mocks.activeWorktreeId,
        settings: { defaultTuiAgent: 'claude' },
        rateLimits: {},
        activeGroupIdByWorktree: {},
        groupsByWorktree: {},
        buildReview: { openStartDialog: mocks.openBuildReviewDialog }
      })
    }
  )
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({
    loading: false,
    capabilities: [{ id: 'claude', label: 'Claude', status: 'usable', models: [] }],
    usable: [{ id: 'claude', label: 'Claude', status: 'usable', models: [] }],
    rates: {},
    refresh: vi.fn().mockResolvedValue([]),
    readCurrent: () => [{ id: 'claude', label: 'Claude', status: 'usable', models: [] }]
  })
}))
vi.mock('@/hooks/useAccountCapacityRows', () => ({ useAccountCapacityRows: () => [] }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => mocks.target,
  getAgentDetectionTargetKeyForWorktree: () => mocks.targetKey
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'scope' }))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => 'scope' }))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: vi.fn(),
  useCompaniesRead: () => ({ data: undefined, loading: false, error: null })
}))
vi.mock('./new-conversation/launcher-target', () => ({
  useLauncherTargets: () => undefined,
  rememberLauncherCompany: vi.fn(),
  openLauncherAccounts: vi.fn()
}))

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true }))
  })
  mocks.launch.mockReset().mockReturnValue({ tabId: 'new-tab' })
  mocks.company.mockReset().mockResolvedValue({ ok: true, workspaceId: 'work', tabId: 'new-tab' })
  mocks.createWorkflow.mockReset().mockReturnValue('workflow-tab')
  mocks.openBuildReviewDialog.mockReset()
  mocks.activeWorktreeId = 'worktree-1'
  mocks.target = { kind: 'local' }
  mocks.targetKey = 'local'
  mocks.activateAndReveal.mockReset()
  mocks.activateTabAndFocusPane.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openMenuByHover(button: HTMLElement): Promise<void> {
  fireEvent.pointerEnter(button)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1)
  })
}

async function pickModel(): Promise<void> {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Model' }))
  await act(async () => {
    await Promise.resolve()
  })
  fireEvent.click(screen.getByRole('menuitem', { name: /Claude/ }))
  await act(async () => {
    await Promise.resolve()
  })
}

describe('NewConversationButton Model / Workflow launch and reveal', () => {
  it('opens a workflow conversation from the Workflow submenu without launching an agent', async () => {
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    // Primary workflows stay visible while Other reveals the remaining workflows.
    const workflows = [
      'Discover',
      'Evolve',
      'Improve',
      'Find the best',
      'Decide',
      'Investigate',
      'Audit',
      'Build + Review'
    ]
    expect(
      screen
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label'))
        .filter((label) => [...workflows, 'Council', 'Describe a workflow'].includes(label ?? ''))
    ).toEqual([...workflows, 'Describe a workflow'])
    expect(screen.getByRole('menuitem', { name: 'Build + Review' }).textContent).toContain(
      'Make a change, then have other AIs review it for a few rounds'
    )
    expect(screen.getByRole('menuitem', { name: 'Discover' }).textContent).toContain(
      'Find real problems in code or documents, and check the important ones'
    )
    expect(
      screen.getByRole('menuitem', { name: 'Build + Review' }).querySelector('svg')
    ).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Decide' }))
    expect(mocks.createWorkflow).toHaveBeenCalledWith('worktree-1', 'decide')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens Build + Review through the original workflow conversation path', async () => {
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build + Review' }))
    expect(mocks.createWorkflow).toHaveBeenCalledWith('worktree-1', 'build-review')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens Build + Review as a tab in an SSH workspace, where the other workflows stay off', async () => {
    mocks.target = { kind: 'ssh' }
    mocks.targetKey = 'ssh:box'
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    expect(
      screen.getByRole('menuitem', { name: 'Decide' }).getAttribute('data-disabled')
    ).not.toBeNull()
    expect(
      screen.getByRole('menuitem', { name: 'Discover' }).getAttribute('data-disabled')
    ).not.toBeNull()
    expect(
      screen.getByRole('menuitem', { name: 'Build + Review' }).getAttribute('data-disabled')
    ).toBeNull()
    expect(screen.getByText(/Build \+ Review also opens in an SSH workspace/)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build + Review' }))
    expect(mocks.createWorkflow).toHaveBeenCalledWith('worktree-1', 'build-review')
    expect(mocks.openBuildReviewDialog).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens Evolve as a tab in an SSH workspace, since it runs on a fleet host', async () => {
    mocks.target = { kind: 'ssh' }
    mocks.targetKey = 'ssh:box'
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    const evolve = screen.getByRole('menuitem', { name: 'Evolve' })
    expect(evolve.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(evolve)
    expect(mocks.createWorkflow).toHaveBeenCalledWith('worktree-1', 'evolve')
  })

  it('opens the Build + Review dialog for a runtime environment workspace', async () => {
    mocks.target = { kind: 'runtime' }
    mocks.targetKey = 'runtime:env-1'
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build + Review' }))
    expect(mocks.openBuildReviewDialog).toHaveBeenCalledWith('worktree-1', undefined)
    expect(mocks.createWorkflow).not.toHaveBeenCalled()
  })

  it('opens the Build + Review dialog when no workspace is active', async () => {
    mocks.activeWorktreeId = null
    mocks.target = undefined
    render(<NewConversationButton />)
    await openMenuByHover(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workflow' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build + Review' }))
    expect(mocks.openBuildReviewDialog).toHaveBeenCalledWith(undefined, undefined)
    expect(mocks.createWorkflow).not.toHaveBeenCalled()
  })

  it('starts at the shared work root instead of inheriting the active workspace', async () => {
    render(<NewConversationButton />)
    const button = screen.getByRole('button', { name: 'New conversation' })
    await openMenuByHover(button)
    await pickModel()
    expect(mocks.company).toHaveBeenCalledWith(
      expect.objectContaining({ company: null, domain: null, conversationLauncher: true })
    )
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('launches once and keeps the menu closed when click lands inside hover delay', async () => {
    render(<NewConversationButton />)
    const button = screen.getByRole('button', { name: 'New conversation' })
    fireEvent.pointerEnter(button)
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1)
    })
    expect(mocks.company).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu closed after a click-launch until the pointer really moves', async () => {
    render(<NewConversationButton />)
    const button = screen.getByRole('button', { name: 'New conversation' })

    await openMenuByHover(button)
    expect(screen.getByRole('menu')).toBeTruthy()

    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(mocks.company).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()

    // The reveal slides "+" out from under a resting cursor and back: boundary events only.
    fireEvent.pointerLeave(button)
    fireEvent.pointerEnter(button)
    await act(async () => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1)
    })
    expect(screen.queryByRole('menu')).toBeNull()

    // A move with no movement, or one that is still part of the click, does not re-arm.
    fireEvent.pointerMove(window, { movementX: 0, movementY: 0 })
    fireEvent.pointerMove(window, { movementX: 3, movementY: 1 })
    fireEvent.pointerEnter(button)
    await act(async () => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1)
    })
    expect(screen.queryByRole('menu')).toBeNull()

    // A real move after the quiet period re-arms hover-open.
    await act(async () => {
      vi.advanceTimersByTime(HOVER_REARM_QUIET_MS)
    })
    fireEvent.pointerMove(window, { movementX: 4, movementY: 2 })
    fireEvent.pointerLeave(button)
    await openMenuByHover(button)
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
