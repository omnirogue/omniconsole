import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ATTENTION_LAUNCH_FAVORITES,
  planAttentionLaunch,
  type AttentionLaunchFavorite
} from '../../../../shared/attention-launch-favorites'

const mocks = vi.hoisted(() => ({ launchAgentInNewTab: vi.fn() }))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: null }) }
}))

import { launchAttentionFavorite } from './attention-favorite-launch'

const [claudeTeams, codexTeam] = DEFAULT_ATTENTION_LAUNCH_FAVORITES as [
  AttentionLaunchFavorite,
  AttentionLaunchFavorite
]

function planFor(
  favorite: AttentionLaunchFavorite,
  detectedAgents: readonly string[] | null = [favorite.agent]
): ReturnType<typeof planAttentionLaunch> {
  return planAttentionLaunch({
    favorite,
    hasWorkspace: true,
    detectedAgents,
    disabledAgents: [],
    experimentalNativeChat: true,
    transcriptLocalReadable: true,
    accountSettings: null,
    targetIsRemote: false
  })
}

describe('launchAttentionFavorite', () => {
  beforeEach(() => {
    mocks.launchAgentInNewTab.mockReset()
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-1' })
  })

  it('submits the Claude Teams prompt once the lead is ready and opens it in chat', () => {
    expect(
      launchAttentionFavorite({ plan: planFor(claudeTeams), worktreeId: 'wt-teams', request: '' })
    ).toEqual({ ok: true, tabId: 'tab-1' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude-agent-teams',
        prompt: expect.stringContaining('Ask me what I need before starting any work.'),
        promptDelivery: 'submit-after-ready',
        launchPreferences: { model: 'claude-opus-5-5[1m]' },
        viewModePreference: 'chat'
      })
    )
  })

  it('keeps command-line delivery for a Codex team, which takes the prompt at launch', () => {
    launchAttentionFavorite({ plan: planFor(codexTeam), worktreeId: 'wt-codex', request: 'Draft' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', promptDelivery: 'auto-submit' })
    )
  })

  it('does not launch while detection is still checking the host', () => {
    expect(
      launchAttentionFavorite({
        plan: planFor(codexTeam, null),
        worktreeId: 'wt-pending',
        request: ''
      })
    ).toEqual({ ok: false, reason: 'blocked' })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('lets a failed launch be retried at once but refuses a repeat after a started one', () => {
    const click = (): ReturnType<typeof launchAttentionFavorite> =>
      launchAttentionFavorite({ plan: planFor(codexTeam), worktreeId: 'wt-retry', request: '' })
    mocks.launchAgentInNewTab.mockReturnValueOnce(null)
    expect(click()).toEqual({ ok: false, reason: 'launch-failed' })
    expect(click()).toEqual({ ok: true, tabId: 'tab-1' })
    expect(click()).toEqual({ ok: false, reason: 'repeat' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(2)
  })

  it('releases the repeat key when the launch throws', () => {
    const click = (): ReturnType<typeof launchAttentionFavorite> =>
      launchAttentionFavorite({ plan: planFor(codexTeam), worktreeId: 'wt-throw', request: '' })
    mocks.launchAgentInNewTab.mockImplementationOnce(() => {
      throw new Error('startup plan failed')
    })
    expect(click).toThrow('startup plan failed')
    expect(click()).toEqual({ ok: true, tabId: 'tab-1' })
  })
})
