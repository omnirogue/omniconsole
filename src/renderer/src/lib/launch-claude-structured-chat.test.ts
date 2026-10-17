import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  startStructuredChatLaunch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars?.[name] ?? '')
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))
vi.mock('./structured-agent-session-launch', () => ({
  startStructuredChatLaunch: mocks.startStructuredChatLaunch
}))

import { launchClaudeStructuredChat } from './launch-claude-structured-chat'

const DELIVERED = { delivered: true, failureNotified: false }
const FELL_BACK = { delivered: false, failureNotified: true }

function rpcError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

describe('launchClaudeStructuredChat', () => {
  let fallback: () => Promise<{ delivered: boolean; failureNotified: boolean }>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    fallback = vi.fn(async () => FELL_BACK) as unknown as () => Promise<{
      delivered: boolean
      failureNotified: boolean
    }>
    mocks.startStructuredChatLaunch.mockResolvedValue(DELIVERED)
  })

  it('asks the executing host and takes the SDK lane when it says yes', async () => {
    mocks.call.mockResolvedValue({ supported: true })

    await expect(
      launchClaudeStructuredChat({ worktreeId: 'wt-1', prompt: 'ship it', fallback })
    ).resolves.toEqual(DELIVERED)

    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.createSupport', {
      worktree: 'id:wt-1',
      agent: 'claude'
    })
    // `agent-session`, never `acp`: recording an ACP transport would pin the record
    // to the other Claude lane for the rest of its life, including after a restart.
    expect(mocks.startStructuredChatLaunch).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      'ship it',
      undefined,
      'claude',
      'agent-session',
      { onSessionCreated: undefined }
    )
    expect(fallback).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it.each([
    ['windows', 'not available on Windows'],
    ['wsl', 'lives in WSL'],
    ['remote', 'another computer'],
    ['agent', 'cannot run a structured Claude session']
  ])('falls back to the terminal naming %s', async (reason, sentence) => {
    mocks.call.mockResolvedValue({ supported: false, reason })

    await expect(launchClaudeStructuredChat({ worktreeId: 'wt-2', fallback })).resolves.toEqual(
      FELL_BACK
    )

    expect(fallback).toHaveBeenCalledOnce()
    expect(mocks.startStructuredChatLaunch).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain(sentence)
  })

  it('names a reason the client already settled without asking the host', async () => {
    await expect(
      launchClaudeStructuredChat({ worktreeId: 'wt-3', refusal: 'custom-launch', fallback })
    ).resolves.toEqual(FELL_BACK)

    expect(mocks.call).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain('carries its own arguments')
  })

  it('reports a reason the host invented as the generic host refusal, never as support', async () => {
    mocks.call.mockResolvedValue({ supported: false, reason: 'reason-from-the-future' })

    await expect(launchClaudeStructuredChat({ worktreeId: 'wt-4', fallback })).resolves.toEqual(
      FELL_BACK
    )
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain(
      'cannot run a structured Claude session'
    )
  })

  it('retries only while the host cannot yet resolve the freshly created worktree', async () => {
    mocks.call
      .mockRejectedValueOnce(rpcError('selector_not_found'))
      .mockRejectedValueOnce(rpcError('selector_not_found'))
      .mockResolvedValueOnce({ supported: true })

    await expect(launchClaudeStructuredChat({ worktreeId: 'wt-5', fallback })).resolves.toEqual(
      DELIVERED
    )
    expect(mocks.call).toHaveBeenCalledTimes(3)
  })

  it('does not retry an error that is a verdict, and never treats silence as a yes', async () => {
    mocks.call.mockRejectedValue(rpcError('some_other_failure'))

    await expect(launchClaudeStructuredChat({ worktreeId: 'wt-6', fallback })).resolves.toEqual(
      FELL_BACK
    )
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.startStructuredChatLaunch).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain('did not answer')
  })

  it('gives up after the bounded retries rather than waiting forever', async () => {
    mocks.call.mockRejectedValue(rpcError('selector_not_found'))

    await expect(launchClaudeStructuredChat({ worktreeId: 'wt-7', fallback })).resolves.toEqual(
      FELL_BACK
    )
    // One initial ask plus the three bounded retries.
    expect(mocks.call).toHaveBeenCalledTimes(4)
    expect(fallback).toHaveBeenCalledOnce()
  })
})
