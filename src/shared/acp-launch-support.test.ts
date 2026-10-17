import { describe, expect, it } from 'vitest'
import { isAcpEnabled } from './acp-launch-support'
import { ACP_STRUCTURED_AGENTS } from './acp-agent-recipes'

describe('ACP opt-in', () => {
  it.each(ACP_STRUCTURED_AGENTS)('requires both settings for %s', (agent) => {
    expect(isAcpEnabled(undefined, agent)).toBe(false)
    expect(isAcpEnabled({ experimentalStructuredNativeChat: true }, agent)).toBe(false)
    expect(isAcpEnabled({ agentUseAcp: { [agent]: true } }, agent)).toBe(false)
    expect(
      isAcpEnabled(
        { experimentalStructuredNativeChat: true, agentUseAcp: { [agent]: true } },
        agent
      )
    ).toBe(true)
    expect(
      isAcpEnabled(
        { experimentalStructuredNativeChat: true, agentUseAcp: { [agent]: false } },
        agent
      )
    ).toBe(false)
  })
})
