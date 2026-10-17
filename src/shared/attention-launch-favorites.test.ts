import { describe, expect, it } from 'vitest'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import {
  attentionLaunchPromptDelivery,
  buildAttentionLaunchPrompt,
  DEFAULT_ATTENTION_LAUNCH_FAVORITES,
  normalizeAttentionLaunchFavorites,
  planAttentionLaunch,
  resolveAttentionLaunchFavorites,
  upsertAttentionLaunchFavorite,
  type AttentionLaunchFavorite
} from './attention-launch-favorites'
import { quoteStartupArg } from './tui-agent-startup-shell'

const [claudeTeams, codexTeam] = DEFAULT_ATTENTION_LAUNCH_FAVORITES as [
  AttentionLaunchFavorite,
  AttentionLaunchFavorite
]

const ready = {
  hasWorkspace: true,
  detectedAgents: ['claude', 'claude-agent-teams', 'codex', 'grok', 'gemini'],
  disabledAgents: [],
  experimentalNativeChat: true,
  transcriptLocalReadable: true,
  accountSettings: {
    agentAccountProfiles: [
      { id: 'work', label: 'Work Claude', agent: 'claude' as const, configDir: '/Users/me/.cw' }
    ]
  },
  targetIsRemote: false
}

describe('Claude Agent Teams model options', () => {
  it("uses Claude's catalog because omni claude-teams forwards Claude flags", () => {
    expect(getAgentSessionOptionCatalog('claude-agent-teams')).toBe(
      getAgentSessionOptionCatalog('claude')
    )
  })

  it('accepts the saved Fable model for the team lead instead of refusing it', () => {
    expect(
      checkAgentLaunchPreferences('claude-agent-teams', { model: 'claude-fable-5-1[1m]' })
    ).toEqual({ ok: true, preferences: { model: 'claude-fable-5-1[1m]' } })
  })

  it('passes the exact model id to the lead and quotes it for POSIX shells', () => {
    const launch = resolveAgentSessionOptionLaunch('claude-agent-teams', {
      model: 'claude-fable-5-1[1m]'
    })
    expect(launch.args).toEqual(['--model', 'claude-fable-5-1[1m]'])
    // Why: `[1m]` is a zsh glob; an unquoted id would fail with "no matches found".
    expect(quoteStartupArg('claude-fable-5-1[1m]', 'posix')).not.toBe('claude-fable-5-1[1m]')
  })

  it('keeps the Codex team favourite at its saved effort', () => {
    expect(checkAgentLaunchPreferences('codex', { model: 'gpt-6-astra', effort: 'max' })).toEqual({
      ok: true,
      preferences: { model: 'gpt-6-astra', effort: 'max' }
    })
    expect(checkAgentLaunchPreferences('codex', { model: 'gpt-6-astra', effort: 'ultra' }).ok).toBe(
      true
    )
  })

  it('still refuses max for a Codex model the catalog does not list', () => {
    expect(checkAgentLaunchPreferences('codex', { model: 'gpt-9-unknown', effort: 'max' }).ok).toBe(
      false
    )
  })
})

describe('planAttentionLaunch', () => {
  it('launches a ready favourite in chat with its exact actor', () => {
    const plan = planAttentionLaunch({ ...ready, favorite: codexTeam })
    expect(plan.blockers).toEqual([])
    expect(plan.view).toEqual({ mode: 'chat' })
    expect(plan.launchPreferences).toEqual({ model: 'gpt-6-astra', effort: 'max' })
    expect(plan.detectionPending).toBe(false)
  })

  it('names a hidden agent instead of launching something else', () => {
    const plan = planAttentionLaunch({
      ...ready,
      favorite: claudeTeams,
      disabledAgents: ['claude-agent-teams']
    })
    expect(plan.blockers).toEqual([{ kind: 'agent-disabled' }])
  })

  it('blocks only once detection has finished without the CLI', () => {
    expect(
      planAttentionLaunch({ ...ready, favorite: claudeTeams, detectedAgents: ['codex'] }).blockers
    ).toEqual([{ kind: 'agent-not-detected' }])
    const pending = planAttentionLaunch({ ...ready, favorite: claudeTeams, detectedAgents: null })
    expect(pending.blockers).toEqual([])
    expect(pending.detectionPending).toBe(true)
  })

  it('requires a workspace', () => {
    expect(
      planAttentionLaunch({ ...ready, favorite: codexTeam, hasWorkspace: false }).blockers
    ).toEqual([{ kind: 'no-workspace' }])
  })

  it.each(['low', 'xhigh'])('refuses explicit favorite effort %s without a model', (effort) => {
    const plan = planAttentionLaunch({
      ...ready,
      favorite: { ...codexTeam, model: undefined, effort }
    })
    expect(plan.blockers).toEqual([
      { kind: 'invalid-preferences', message: '--effort requires --model.' }
    ])
  })

  it.each([
    [{ agent: 'gemini' as const }, { experimentalNativeChat: true }, 'agent-unsupported'],
    [{ agent: 'grok' as const }, { transcriptLocalReadable: false }, 'transcript-not-readable'],
    [{ agent: 'claude' as const }, { experimentalNativeChat: false }, 'chat-ui-off'],
    [{ agent: 'claude' as const, viewMode: 'terminal' as const }, {}, 'preference']
  ])('explains why %o opens in Terminal', (favoritePatch, inputPatch, reason) => {
    const favorite: AttentionLaunchFavorite = {
      id: 'x',
      label: 'x',
      viewMode: 'chat',
      ...favoritePatch
    }
    expect(planAttentionLaunch({ ...ready, ...inputPatch, favorite }).view).toEqual({
      mode: 'terminal',
      reason
    })
  })

  it('opens the Claude Agent Teams lead in chat', () => {
    expect(planAttentionLaunch({ ...ready, favorite: claudeTeams }).view).toEqual({ mode: 'chat' })
  })

  it("resolves the team lead's saved account from Claude's profiles", () => {
    const plan = planAttentionLaunch({
      ...ready,
      favorite: { ...claudeTeams, accountChoiceId: 'profile:work' }
    })
    expect(plan.blockers).toEqual([])
    expect(plan.account).toMatchObject({ id: 'profile:work', label: 'Work Claude' })
  })

  it('blocks a saved account that no longer exists instead of using the default sign-in', () => {
    const plan = planAttentionLaunch({
      ...ready,
      favorite: { ...claudeTeams, accountChoiceId: 'profile:gone' }
    })
    expect(plan.blockers).toEqual([{ kind: 'account-missing' }])
    expect(plan.account).toBeNull()
  })

  it("blocks a saved account on a remote host, which can't read this computer's directory", () => {
    const favorite = { ...claudeTeams, accountChoiceId: 'profile:work' }
    expect(planAttentionLaunch({ ...ready, favorite, targetIsRemote: true }).blockers).toEqual([
      { kind: 'account-local-only' }
    ])
    expect(
      planAttentionLaunch({ ...ready, favorite: claudeTeams, targetIsRemote: true }).blockers
    ).toEqual([])
  })

  it('stops waiting on detection once a remote probe has failed', () => {
    const plan = planAttentionLaunch({
      ...ready,
      favorite: codexTeam,
      detectedAgents: null,
      detectionFailed: true
    })
    expect(plan.detectionPending).toBe(false)
    expect(plan.blockers).toEqual([])
  })
})

describe('attentionLaunchPromptDelivery', () => {
  it('submits a team prompt once the lead is ready instead of leaving an unsent draft', () => {
    // Agent Teams takes no prompt on the command line, so auto-submit would only paste it.
    expect(
      attentionLaunchPromptDelivery(
        'claude-agent-teams',
        buildAttentionLaunchPrompt(claudeTeams, '')
      )
    ).toBe('submit-after-ready')
  })

  it('keeps command-line delivery for agents that take the prompt at launch', () => {
    expect(attentionLaunchPromptDelivery('codex', 'Draft the email')).toBe('auto-submit')
    expect(attentionLaunchPromptDelivery('claude', 'Draft the email')).toBe('auto-submit')
    expect(attentionLaunchPromptDelivery('claude-agent-teams', '   ')).toBe('auto-submit')
  })
})

describe('normalizeAttentionLaunchFavorites', () => {
  it('falls back to the built-in pair when nothing was saved', () => {
    expect(normalizeAttentionLaunchFavorites(undefined)).toBeUndefined()
    expect(resolveAttentionLaunchFavorites({})).toBe(DEFAULT_ATTENTION_LAUNCH_FAVORITES)
  })

  it('keeps an intentionally empty list', () => {
    expect(normalizeAttentionLaunchFavorites([])).toEqual([])
  })

  it('drops malformed rows, duplicate ids and an effort without a model', () => {
    expect(
      normalizeAttentionLaunchFavorites([
        { id: 'ok', label: ' Mine ', agent: 'codex', effort: 'xhigh', viewMode: 'chat' },
        { id: 'ok', label: 'Duplicate', agent: 'claude', viewMode: 'chat' },
        { id: 'bad id!', label: 'x', agent: 'claude' },
        { id: 'no-agent', label: 'x', agent: 'not-an-agent' },
        { id: 'team', label: 'T', agent: 'claude', team: 'swarm', viewMode: 'sideways' }
      ])
    ).toEqual([
      { id: 'ok', label: 'Mine', agent: 'codex', viewMode: 'chat' },
      { id: 'team', label: 'T', agent: 'claude', viewMode: 'terminal' }
    ])
  })

  it('round-trips the built-in favourites unchanged', () => {
    expect(normalizeAttentionLaunchFavorites([...DEFAULT_ATTENTION_LAUNCH_FAVORITES])).toEqual(
      DEFAULT_ATTENTION_LAUNCH_FAVORITES
    )
  })

  it('replaces an edited favourite in place', () => {
    const edited = { ...claudeTeams, accountChoiceId: 'profile:work' }
    expect(upsertAttentionLaunchFavorite(DEFAULT_ATTENTION_LAUNCH_FAVORITES, edited)).toEqual([
      edited,
      codexTeam
    ])
  })
})

describe('buildAttentionLaunchPrompt', () => {
  it('sends a plain favourite the request unchanged', () => {
    const favorite: AttentionLaunchFavorite = {
      id: 'c',
      label: 'Claude',
      agent: 'claude',
      viewMode: 'chat'
    }
    expect(buildAttentionLaunchPrompt(favorite, '  Summarise the notes  ')).toBe(
      'Summarise the notes'
    )
  })

  it('tells a team lead to keep simple work single-agent and workers on its model', () => {
    const prompt = buildAttentionLaunchPrompt(codexTeam, 'Draft the launch email')
    expect(prompt).toContain('Codex subagents')
    expect(prompt).toContain('do simple requests yourself without starting workers')
    expect(prompt).toContain('gpt-6-astra at max effort')
    expect(prompt.endsWith('Request:\nDraft the launch email')).toBe(true)
  })

  it('asks for the request instead of inventing work when none was typed', () => {
    expect(buildAttentionLaunchPrompt(claudeTeams, '   ')).toContain(
      'Ask me what I need before starting any work.'
    )
  })
})
