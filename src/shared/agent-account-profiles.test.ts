import { describe, expect, it } from 'vitest'
import {
  agentSupportsAccountProfiles,
  isAccountProfileOwnerAgent,
  listAgentAccountChoices,
  normalizeAgentAccountProfiles,
  resolveAgentAccountLaunchEnv
} from './agent-account-profiles'
import type { ClaudeManagedAccount, CodexManagedAccount } from './managed-account-types'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'

describe('isAccountProfileOwnerAgent', () => {
  it('saves profiles under Claude and Codex only, while Agent Teams still reads Claude ones', () => {
    const owners = ALL_TUI_AGENTS.filter((agent) => isAccountProfileOwnerAgent(agent))
    expect(new Set(owners)).toEqual(new Set(['claude', 'codex']))
    expect(agentSupportsAccountProfiles('claude-agent-teams')).toBe(true)
    expect(
      listAgentAccountChoices(
        {
          agentAccountProfiles: [{ id: 'p1', label: 'Pool', agent: 'claude', configDir: '/pool' }]
        },
        'claude-agent-teams'
      )
    ).toEqual([
      { id: 'profile:p1', label: 'Pool', kind: 'profile', env: { CLAUDE_CONFIG_DIR: '/pool' } }
    ])
  })
})

const claudeHost: ClaudeManagedAccount = {
  id: 'acc-claude-1',
  email: 'one@example.com',
  managedAuthPath: '/managed/acc-claude-1/auth',
  managedAuthRuntime: 'host',
  authMethod: 'subscription-oauth',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

const claudeWsl: ClaudeManagedAccount = {
  ...claudeHost,
  id: 'acc-claude-wsl',
  email: 'wsl@example.com',
  managedAuthRuntime: 'wsl',
  wslDistro: 'Ubuntu',
  wslLinuxAuthPath: '/home/u/.omni/claude'
}

const codexHost: CodexManagedAccount = {
  id: 'acc-codex-1',
  email: 'codex@example.com',
  managedHomePath: '/managed/acc-codex-1/home',
  managedHomeRuntime: 'host',
  workspaceLabel: 'Team',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

describe('normalizeAgentAccountProfiles', () => {
  it('keeps only complete profiles for agents with a config-directory variable', () => {
    expect(
      normalizeAgentAccountProfiles([
        { id: 'p1', label: ' Pool slot 3 ', agent: 'claude', configDir: ' /pool/slot-3 ' },
        { id: 'p2', label: 'Codex second', agent: 'codex', configDir: '/codex/second' },
        { id: 'p3', label: 'No dir', agent: 'claude', configDir: '' },
        { id: 'p4', label: 'Unsupported', agent: 'grok', configDir: '/x' },
        { id: 'p1', label: 'Duplicate id', agent: 'claude', configDir: '/dup' },
        'junk',
        null
      ])
    ).toEqual([
      { id: 'p1', label: 'Pool slot 3', agent: 'claude', configDir: '/pool/slot-3' },
      { id: 'p2', label: 'Codex second', agent: 'codex', configDir: '/codex/second' }
    ])
    expect(normalizeAgentAccountProfiles(undefined)).toEqual([])
  })
})

describe('listAgentAccountChoices', () => {
  const settings = {
    claudeManagedAccounts: [claudeHost, claudeWsl],
    codexManagedAccounts: [codexHost],
    agentAccountProfiles: [
      { id: 'p1', label: 'Pool slot 3', agent: 'claude' as const, configDir: '/pool/slot-3' },
      { id: 'p2', label: 'Codex second', agent: 'codex' as const, configDir: '/codex/second' }
    ]
  }

  it('lists host managed accounts before named profiles and maps each to its env', () => {
    expect(listAgentAccountChoices(settings, 'claude')).toEqual([
      {
        id: 'managed:acc-claude-1',
        label: 'one@example.com',
        kind: 'managed',
        env: { CLAUDE_CONFIG_DIR: '/managed/acc-claude-1/auth/session' }
      },
      {
        id: 'profile:p1',
        label: 'Pool slot 3',
        kind: 'profile',
        env: { CLAUDE_CONFIG_DIR: '/pool/slot-3' }
      }
    ])
    expect(listAgentAccountChoices(settings, 'codex')).toEqual([
      {
        id: 'managed:acc-codex-1',
        label: 'codex@example.com (Team)',
        kind: 'managed',
        env: { CODEX_HOME: '/managed/acc-codex-1/home' }
      },
      {
        id: 'profile:p2',
        label: 'Codex second',
        kind: 'profile',
        env: { CODEX_HOME: '/codex/second' }
      }
    ])
  })

  it('offers nothing for agents without a config-directory variable', () => {
    expect(listAgentAccountChoices(settings, 'grok')).toEqual([])
    expect(listAgentAccountChoices(null, 'claude')).toEqual([])
  })

  it('resolves a chosen account to its launch env and unknown choices to the default', () => {
    expect(resolveAgentAccountLaunchEnv(settings, 'claude', 'profile:p1')).toEqual({
      CLAUDE_CONFIG_DIR: '/pool/slot-3'
    })
    expect(
      resolveAgentAccountLaunchEnv(settings, 'claude', 'managed:acc-claude-wsl')
    ).toBeUndefined()
    expect(resolveAgentAccountLaunchEnv(settings, 'claude', null)).toBeUndefined()
    expect(resolveAgentAccountLaunchEnv(settings, 'claude', 'profile:gone')).toBeUndefined()
  })
})
