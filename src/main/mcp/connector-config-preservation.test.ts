import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rememberConnectorChoice,
  preserveAccountConnectorConfig,
  persistRemovedConnector,
  restoreClaudeConnectorChoice
} from './connector-config-preservation'

describe('connector choices across config refresh and relaunch', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'connector-preservation-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('keeps account connectors while still taking unrelated system changes', () => {
    rememberConnectorChoice(home, 'private', 'keep')
    const result = preserveAccountConnectorConfig(
      home,
      'model="old"\n[mcp_servers.private]\nurl="https://private.example/mcp"',
      'model="new"\n[mcp_servers.shared]\ncommand="shared-server"'
    )
    expect(result).toContain('model = "new"')
    expect(result).toContain('https://private.example/mcp')
    expect(result).toContain('shared-server')
  })

  it('keeps removal effective when the system config still contains the connector', () => {
    rememberConnectorChoice(home, 'omni-console', 'remove')
    const result = preserveAccountConnectorConfig(
      home,
      '',
      '[mcp_servers.omni-console]\nurl="https://console.example.com/mcp"'
    )
    expect(result).toContain('enabled = false')
    expect(result).not.toContain('https://omnios')
    expect(result).toContain('omni-connector-removed')
  })

  it('does not rewrite unchanged accounts or silently discard corrupt account preferences', () => {
    const system = '# retain this comment\nmodel="new"\n'
    expect(preserveAccountConnectorConfig(home, '', system)).toBe(system)
    writeFileSync(join(home, '.omni-mcp-account-overrides.json'), 'invalid')
    expect(() => preserveAccountConnectorConfig(home, '', system)).toThrow()
  })

  it('prevents Claude auto-provisioning after removal and enables an explicit re-add', () => {
    const file = join(home, '.claude.json')
    writeFileSync(file, JSON.stringify({ other: 'retained', mcpServers: {} }))
    persistRemovedConnector(home, 'claude', file, 'omni-console')
    expect(JSON.parse(readFileSync(file, 'utf8')).disabledMcpServers).toEqual(['omni-console'])
    restoreClaudeConnectorChoice(file, 'omni-console')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      other: 'retained',
      mcpServers: {},
      disabledMcpServers: []
    })
  })
})
