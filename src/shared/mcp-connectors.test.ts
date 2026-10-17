import { describe, expect, it } from 'vitest'
import { validateConnectorDefinition } from './mcp-connectors'

describe('connector input boundary', () => {
  it('allows HTTPS and loopback HTTP without allowing remote cleartext or URL credentials', () => {
    expect(
      validateConnectorDefinition({
        name: 'docs',
        transport: 'http',
        url: 'https://example.com/mcp'
      }).url
    ).toBe('https://example.com/mcp')
    expect(
      validateConnectorDefinition({
        name: 'local',
        transport: 'http',
        url: 'http://127.0.0.1:3000/mcp'
      }).url
    ).toContain('127.0.0.1')
    for (const url of [
      'http://example.com/mcp',
      'file:///tmp/mcp',
      'https://user:secret@example.com/mcp'
    ]) {
      expect(() => validateConnectorDefinition({ name: 'docs', transport: 'http', url })).toThrow()
    }
  })
  it('keeps executable arguments literal and rejects option injection and malformed arguments', () => {
    const value = {
      name: 'local',
      transport: 'stdio' as const,
      command: '/path with spaces/server',
      args: ['$(touch /tmp/no)', '--port', '3000']
    }
    expect(validateConnectorDefinition(value)).toEqual(value)
    expect(() => validateConnectorDefinition({ ...value, name: '--config' })).toThrow()
    expect(() => validateConnectorDefinition({ ...value, args: {} as string[] })).toThrow()
    expect(() => validateConnectorDefinition({ ...value, command: 'server\nother' })).toThrow()
  })
})
