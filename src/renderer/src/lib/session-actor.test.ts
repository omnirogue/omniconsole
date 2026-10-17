import { describe, expect, it } from 'vitest'
import { resolveSessionActorLaunch } from './session-actor'

const settings = {
  claudeManagedAccounts: [
    {
      id: 'acc-1',
      email: 'one@example.com',
      managedAuthPath: '/managed/acc-1/auth',
      managedAuthRuntime: 'host' as const,
      authMethod: 'subscription-oauth' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ],
  codexManagedAccounts: [],
  agentAccountProfiles: [
    { id: 'p1', label: 'Pool slot 3', agent: 'claude' as const, configDir: '/pool/slot-3' }
  ]
}

describe('resolveSessionActorLaunch', () => {
  it('maps an empty actor to no preferences and no env', () => {
    expect(resolveSessionActorLaunch(settings, 'claude', {})).toEqual({
      launchPreferences: null,
      launchEnv: null
    })
    expect(resolveSessionActorLaunch(settings, 'claude', null)).toEqual({
      launchPreferences: null,
      launchEnv: null
    })
  })

  it('carries model and effort and resolves the chosen account to its directory', () => {
    expect(
      resolveSessionActorLaunch(settings, 'claude', {
        model: 'opus',
        effort: 'max',
        accountChoiceId: 'profile:p1'
      })
    ).toEqual({
      launchPreferences: { model: 'opus', effort: 'max' },
      launchEnv: { CLAUDE_CONFIG_DIR: '/pool/slot-3' }
    })
    expect(
      resolveSessionActorLaunch(settings, 'claude', { accountChoiceId: 'managed:acc-1' })
    ).toEqual({
      launchPreferences: null,
      launchEnv: { CLAUDE_CONFIG_DIR: '/managed/acc-1/auth/session' }
    })
  })

  it('drops an effort that has no model and an account that no longer exists', () => {
    expect(
      resolveSessionActorLaunch(settings, 'claude', {
        effort: 'max',
        accountChoiceId: 'profile:gone'
      })
    ).toEqual({ launchPreferences: null, launchEnv: null })
  })
})
