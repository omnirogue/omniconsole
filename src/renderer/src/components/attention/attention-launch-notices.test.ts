import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ATTENTION_LAUNCH_FAVORITES,
  planAttentionLaunch,
  type AttentionLaunchFavorite
} from '../../../../shared/attention-launch-favorites'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : agent)
}))

import {
  attentionDetectionUnchecked,
  buildAttentionLaunchNotices
} from './attention-launch-notices'

const [claudeTeams, codexTeam] = DEFAULT_ATTENTION_LAUNCH_FAVORITES as [
  AttentionLaunchFavorite,
  AttentionLaunchFavorite
]

const baseInput = {
  hasWorkspace: true,
  detectedAgents: ['claude-agent-teams', 'codex'],
  disabledAgents: [],
  experimentalNativeChat: true,
  transcriptLocalReadable: true,
  accountSettings: {
    agentAccountProfiles: [
      { id: 'work', label: 'Work', agent: 'claude' as const, configDir: '/Users/me/.cw' }
    ]
  },
  targetIsRemote: false
}

function context(host: string, editFavorite = vi.fn()) {
  return { hasWorkspace: true, host, showAgent: vi.fn(), turnOnChat: vi.fn(), editFavorite }
}

describe('buildAttentionLaunchNotices', () => {
  it('says the host is being checked while detection runs, and omits an unknown host', () => {
    const pending = [
      planAttentionLaunch({ ...baseInput, detectedAgents: null, favorite: codexTeam })
    ]
    expect(buildAttentionLaunchNotices(pending, context('mac-studio'))[0]).toEqual({
      key: 'checking',
      text: 'Checking mac-studio…'
    })
    expect(buildAttentionLaunchNotices(pending, context(''))[0]?.text).toBe('Checking…')
  })

  it('names a missing CLI without an empty host clause', () => {
    const plans = [planAttentionLaunch({ ...baseInput, detectedAgents: [], favorite: codexTeam })]
    expect(buildAttentionLaunchNotices(plans, context('')).map((notice) => notice.text)).toEqual([
      'Codex is not installed.'
    ])
    expect(buildAttentionLaunchNotices(plans, context('box')).map((notice) => notice.text)).toEqual(
      ['Codex is not installed on box.']
    )
  })

  it('offers the favourite editor for a removed account, without the internal id', () => {
    const editFavorite = vi.fn()
    const plans = [
      planAttentionLaunch({
        ...baseInput,
        favorite: { ...claudeTeams, accountChoiceId: 'profile:gone' }
      })
    ]
    const [notice] = buildAttentionLaunchNotices(plans, context('box', editFavorite))
    expect(notice?.text).toBe('Claude Teams · Opus 5.5: its saved account is no longer available.')
    expect(notice?.text).not.toContain('profile:')
    notice?.action?.run()
    expect(editFavorite).toHaveBeenCalledWith('claude-teams-opus')
  })

  it('explains that a local account cannot follow the workspace to a remote host', () => {
    const plans = [
      planAttentionLaunch({
        ...baseInput,
        targetIsRemote: true,
        favorite: { ...claudeTeams, accountChoiceId: 'profile:work' }
      })
    ]
    expect(buildAttentionLaunchNotices(plans, context('build-box'))[0]?.text).toBe(
      "Claude Teams · Opus 5.5: its account is saved on this computer and can't be used on build-box."
    )
  })
})

describe('attentionDetectionUnchecked', () => {
  it('waits only while a resolved host is being probed', () => {
    expect(
      attentionDetectionUnchecked({ hasWorkspace: true, targetResolved: true, probeFailed: false })
    ).toBe(false)
  })

  it('never waits on a host the store cannot resolve or a probe that failed', () => {
    expect(
      attentionDetectionUnchecked({ hasWorkspace: true, targetResolved: false, probeFailed: false })
    ).toBe(true)
    expect(
      attentionDetectionUnchecked({ hasWorkspace: true, targetResolved: true, probeFailed: true })
    ).toBe(true)
    const plan = planAttentionLaunch({
      ...baseInput,
      detectedAgents: null,
      detectionFailed: true,
      favorite: claudeTeams
    })
    expect(plan.detectionPending).toBe(false)
    expect(buildAttentionLaunchNotices([plan], context('')).map((notice) => notice.key)).toEqual([])
  })

  it('leaves a missing workspace to its own blocker', () => {
    expect(
      attentionDetectionUnchecked({
        hasWorkspace: false,
        targetResolved: false,
        probeFailed: false
      })
    ).toBe(false)
  })
})
