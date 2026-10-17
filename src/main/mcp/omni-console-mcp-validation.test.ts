import { describe, expect, it } from 'vitest'
import { hasLaunchableOmniConsoleMcp } from './omni-console-mcp-validation'
import { mergeOmniConsoleMcpConfig, OMNI_CONSOLE_MCP_URL } from '../../shared/mcp-config'

describe('connector configuration availability', () => {
  it('uses Gemini HTTP transport without auto-trusting tools or copying credentials', () => {
    const config = mergeOmniConsoleMcpConfig({ theme: 'existing' }, true, 'gemini')
    // Why: the only header values are env references the CLI expands per pane — never a credential.
    expect(config).toEqual({
      theme: 'existing',
      mcpServers: {
        'omni-console': {
          httpUrl: OMNI_CONSOLE_MCP_URL,
          headers: {
            'X-Omni-Ledger-Session': '${OMNI_LEDGER_SESSION_ID}',
            'X-Omni-Ledger-Attempt': '${OMNI_LEDGER_ATTEMPT_ID}'
          }
        }
      }
    })
    expect(hasLaunchableOmniConsoleMcp(config)).toBe(true)
  })
  it.each([
    { mcpServers: { 'omni-console': { enabled: false, url: OMNI_CONSOLE_MCP_URL } } },
    { mcpServers: { 'omni-console': { url: 'https://another.test/mcp' } } },
    { mcpServers: { 'omni-console': null } },
    { disabledMcpServers: ['omni-console'] },
    { disabledMcpjsonServers: ['omni-console'] },
    { disabled_mcp_servers: ['omni-console'] },
    { mcp: { allowed: ['other'] } },
    { mcp: { excluded: ['omni-console'] } }
  ])('refuses unavailable declarations without changing them (%j)', (config) => {
    const before = JSON.stringify(config)
    expect(() => hasLaunchableOmniConsoleMcp(config)).toThrow('disabled or overridden')
    expect(JSON.stringify(config)).toBe(before)
  })
  it('recognizes native Grok and Codex TOML server tables', () => {
    expect(
      hasLaunchableOmniConsoleMcp(
        { mcp_servers: { 'omni-console': { url: OMNI_CONSOLE_MCP_URL } } },
        true
      )
    ).toBe(true)
    expect(hasLaunchableOmniConsoleMcp({})).toBe(false)
  })
})
