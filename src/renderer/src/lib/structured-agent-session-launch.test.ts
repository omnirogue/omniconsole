import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-codex-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredCodexSessionLaunchIntent: mocks.createIntent,
    launchStructuredCodexSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  startStructuredCodexLaunch,
  startStructuredChatLaunch
} from './structured-agent-session-launch'
import { queueStructuredLaunchPrompt } from './structured-launch-prompt-queue'

vi.mock('./structured-launch-prompt-queue', () => ({
  queueStructuredLaunchPrompt: vi.fn(() => true)
}))

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredCodexLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createIntent.mockImplementation((worktreeId: string) => launchIntent(worktreeId))
  })

  it.each([true, false])('reports durable prompt delivery accurately: %s', async (accepted) => {
    const worktreeId = `wt-chat-delivery-${accepted}`
    const intent = { ...launchIntent(worktreeId), prompt: 'Run the final prompt' }
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue(intent.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    vi.mocked(queueStructuredLaunchPrompt).mockReturnValueOnce(accepted)
    const delivered = vi.fn()
    await expect(
      startStructuredChatLaunch(
        worktreeId,
        { model: 'gpt-5', effort: 'high' },
        intent.prompt,
        delivered
      )
    ).resolves.toEqual({ delivered: accepted, failureNotified: !accepted })
    expect(mocks.createIntent).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'gpt-5',
          effort: 'high',
          chatPermissionMode: 'bypass',
          approvalPolicy: 'never'
        })
      })
    )
    expect(queueStructuredLaunchPrompt).toHaveBeenCalledWith(intent.sessionId, intent.prompt)
    expect(delivered).toHaveBeenCalledTimes(accepted ? 1 : 0)
  })

  // The transport is what the host's router reads back off a recovered record, so
  // an agent name alone must not imply one.
  it.each([
    ['acp' as const, 'claude' as const, 'acp'],
    ['agent-session' as const, 'claude' as const, undefined],
    [undefined, undefined, undefined]
  ])('records transport %s for agent %s', async (transport, agent, recorded) => {
    const worktreeId = `wt-transport-${transport ?? 'default'}-${agent ?? 'codex'}`
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue(intent.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    await startStructuredChatLaunch(
      worktreeId,
      undefined,
      undefined,
      undefined,
      agent,
      ...(transport ? ([transport] as const) : [])
    )

    const request = mocks.createIntent.mock.calls.at(-1)?.[1] as {
      agent?: string
      options?: Record<string, string>
    }
    expect(request?.agent).toBe(agent)
    expect(request?.options?.transport).toBe(recorded)
  })

  it('opens the chat without an informational progress toast', async () => {
    const worktreeId = 'wt-open-quiet'
    const intent = launchIntent(worktreeId, 'session-1')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue(intent.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('coalesces a duplicate click silently while the launch is in flight', async () => {
    const worktreeId = 'wt-duplicate-click'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (sessionId: string) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () => new Promise<string>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    startStructuredCodexLaunch(worktreeId)

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    resolveLaunch(intent.sessionId)
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps deliberate draft launches independent while deduplicating the same draft intent', async () => {
    const worktreeId = 'wt-independent-drafts'
    const first = launchIntent(worktreeId, 'session-draft-one')
    const second = launchIntent(worktreeId, 'session-draft-two')
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const resolveLaunches: (() => void)[] = []
    mocks.launch.mockImplementation(
      (intent: StructuredAgentSessionLaunchIntent) =>
        new Promise<string>((resolve) => resolveLaunches.push(() => resolve(intent.sessionId)))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, first.sessionId),
      publishedSnapshot(worktreeId, second.sessionId)
    ])
    const launches = [
      startStructuredChatLaunch(worktreeId, undefined, undefined, undefined, undefined, 'acp', {
        launchKey: 'draft-one',
        groupId: 'group-one'
      }),
      startStructuredChatLaunch(worktreeId, undefined, undefined, undefined, undefined, 'acp', {
        launchKey: 'draft-one',
        groupId: 'group-one'
      }),
      startStructuredChatLaunch(worktreeId, undefined, undefined, undefined, undefined, 'acp', {
        launchKey: 'draft-two',
        groupId: 'group-two'
      })
    ]
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      1,
      worktreeId,
      expect.objectContaining({ launchKey: 'draft-one', groupId: 'group-one' })
    )
    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      2,
      worktreeId,
      expect.objectContaining({ launchKey: 'draft-two', groupId: 'group-two' })
    )
    resolveLaunches.forEach((resolve) => resolve())
    await expect(Promise.all(launches)).resolves.toEqual([
      { delivered: true, failureNotified: false },
      { delivered: true, failureNotified: false },
      { delivered: true, failureNotified: false }
    ])
  })

  it('reconciles a host commit when the create reply is lost', async () => {
    const worktreeId = 'wt-response-loss'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new Error('response lost'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('retries an absent unknown outcome with the exact same intent', async () => {
    const worktreeId = 'wt-same-envelope-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(intent.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, intent.sessionId)])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(intent)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps an unresolved identity reserved until inventory reconciles it', async () => {
    const worktreeId = 'wt-still-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    expect(toast.error).toHaveBeenCalledOnce()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('releases a definitively refused intent so a new click can create a new identity', async () => {
    const worktreeId = 'wt-refused'
    const first = launchIntent(worktreeId, 'session-first')
    const second = launchIntent(worktreeId, 'session-second')
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce(second.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, second.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(first)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(second)
    expect(toast.error).toHaveBeenCalledOnce()
  })
})
