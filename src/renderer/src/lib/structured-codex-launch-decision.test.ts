import { describe, expect, it } from 'vitest'
import { decideStructuredCodexLaunch } from './structured-codex-launch-decision'

const structuredSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }
}

const base = {
  agent: 'codex' as const,
  settings: structuredSettings,
  hostSupport: () => ({ supported: true }) as const,
  customAgentArgs: null,
  launchEnv: null,
  shell: 'posix' as const
}

describe('decideStructuredCodexLaunch', () => {
  it('takes the structured runtime with the shipped yolo default args', () => {
    expect(decideStructuredCodexLaunch(base)).toEqual({ structured: true })
  })

  it('stays silent when the person has not opted into structured chat', () => {
    expect(
      decideStructuredCodexLaunch({
        ...base,
        settings: { ...structuredSettings, openAgentTabsInChatByDefault: false }
      })
    ).toEqual({ structured: false, reason: 'default-view-terminal', explain: false })
    expect(
      decideStructuredCodexLaunch({
        ...base,
        settings: { ...structuredSettings, experimentalStructuredNativeChat: false }
      })
    ).toEqual({ structured: false, reason: 'structured-off', explain: false })
    expect(decideStructuredCodexLaunch({ ...base, agent: 'claude' })).toEqual({
      structured: false,
      reason: 'agent',
      explain: false
    })
  })

  it('explains host, override and environment fallbacks the person did not choose', () => {
    expect(
      decideStructuredCodexLaunch({
        ...base,
        hostSupport: () => ({ supported: false, reason: 'remote' })
      })
    ).toEqual({ structured: false, reason: 'remote', explain: true })
    expect(decideStructuredCodexLaunch({ ...base, customAgentArgs: '--no-alt-screen' })).toEqual({
      structured: false,
      reason: 'custom-args',
      detail: '--no-alt-screen',
      explain: true
    })
    expect(
      decideStructuredCodexLaunch({ ...base, launchEnv: { CODEX_HOME: '/accounts/b' } })
    ).toEqual({ structured: false, reason: 'launch-env', detail: 'CODEX_HOME', explain: true })
  })

  it('refuses default arguments the app-server cannot take, naming the token', () => {
    const decision = decideStructuredCodexLaunch({
      ...base,
      settings: { ...structuredSettings, agentDefaultArgs: { codex: '--no-alt-screen' } }
    })
    expect(decision).toMatchObject({ structured: false, reason: 'default-args', explain: true })
    expect((decision as { detail?: string }).detail).toContain('--no-alt-screen')
  })
})
