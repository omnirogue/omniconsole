/** @vitest-environment happy-dom */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationLaunch } from './new-conversation/use-conversation-launch'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  company: vi.fn(),
  create: vi.fn(),
  error: vi.fn(),
  setOpen: vi.fn(),
  reserve: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { defaultTuiAgent: 'claude' },
      rateLimits: {},
      activeGroupIdByWorktree: {},
      groupsByWorktree: {}
    })
  }
}))
vi.mock('@/lib/conversation-launch-draft', () => ({ reserveConversationLaunch: mocks.reserve }))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => 'test' }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.company,
  createCompanySessionFolder: mocks.create
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: vi.fn() } }))
const input = () => ({
  worktreeId: 'workspace' as string | null,
  scope: 'test',
  local: true,
  rows: { claude: [], codex: [] },
  readCapabilities: () => [
    { id: 'claude' as const, label: 'Claude', status: 'usable', models: [] }
  ],
  setOpen: mocks.setOpen
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.launch.mockReturnValue({ tabId: 'tab' })
  mocks.company.mockResolvedValue({ ok: true, workspaceId: 'folder' })
})
describe('launcher submission', () => {
  it('ignores a remembered company when a fresh conversation uses the work root', async () => {
    const { result } = renderHook(() =>
      useConversationLaunch({
        ...input(),
        worktreeId: null,
        defaultToWorkRoot: true,
        company: { name: 'OmniRogue', slug: 'omnirogue' }
      })
    )
    await act(() => result.current.start())
    expect(mocks.company).toHaveBeenCalledWith(
      expect.objectContaining({ company: null, domain: null, note: '' })
    )
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('starts a blank conversation without a prompt, outcome or forced model', async () => {
    const { result } = renderHook(() => useConversationLaunch(input()))
    await act(() => result.current.start())
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'workspace',
        conversationLauncher: true,
        launchPreferences: undefined
      })
    )
    expect(mocks.launch.mock.calls[0][0]).not.toHaveProperty('prompt')
    expect(mocks.launch.mock.calls[0][0]).not.toHaveProperty('outcome')
    expect(mocks.setOpen).toHaveBeenCalledWith(false)
  })
  it('opens the company menu when no target exists', async () => {
    const { result } = renderHook(() => useConversationLaunch({ ...input(), worktreeId: null }))
    await act(() => result.current.start())
    expect(mocks.setOpen).toHaveBeenCalledWith(true)
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('starts the chosen company with launcher preferences', async () => {
    const { result } = renderHook(() => useConversationLaunch({ ...input(), worktreeId: null }))
    await act(() => result.current.start({}, { name: 'Company', slug: 'company' }))
    expect(mocks.company).toHaveBeenCalledWith(
      expect.objectContaining({
        company: { name: 'Company', slug: 'company' },
        conversationLauncher: true,
        note: ''
      })
    )
  })
  it('a plain click discards a stale company-picker provider pick', async () => {
    const capabilities = () => [
      { id: 'claude' as const, label: 'Claude', status: 'usable', models: [] },
      { id: 'codex' as const, label: 'Codex', status: 'usable', models: [] }
    ]
    const { result, rerender } = renderHook(
      ({ worktreeId }) =>
        useConversationLaunch({ ...input(), worktreeId, readCapabilities: capabilities }),
      { initialProps: { worktreeId: null as string | null } }
    )
    await act(() => result.current.start({ agent: 'codex' }))
    rerender({ worktreeId: 'workspace' })
    await act(() => result.current.start())
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }))
  })
  it('clears a cancelled company pick before a later company selection', async () => {
    const readCapabilities = () => [
      ...input().readCapabilities(),
      { id: 'codex' as const, label: 'Codex', status: 'usable', models: [] }
    ]
    const { result, rerender } = renderHook(
      ({ open }) => useConversationLaunch({ ...input(), worktreeId: null, open, readCapabilities }),
      { initialProps: { open: true } }
    )
    await act(() => result.current.start({ agent: 'codex' }))
    rerender({ open: false })
    rerender({ open: true })
    await act(() => result.current.start(undefined, { name: 'Company' }))
    expect(mocks.company).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }))
  })
  it('reserves a conversation while detection is pending', async () => {
    const { result } = renderHook(() =>
      useConversationLaunch({
        ...input(),
        loading: true,
        readCapabilities: () => [],
        refreshCapabilities: async () => input().readCapabilities()
      })
    )
    await act(() => {
      void result.current.start()
    })
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'workspace', verify: expect.any(Function) })
    )
    expect(mocks.launch).not.toHaveBeenCalled()
    await expect(mocks.reserve.mock.calls[0][0].verify()).resolves.toMatchObject({
      agent: 'claude',
      conversationLauncher: true
    })
  })
})
