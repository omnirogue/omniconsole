import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'

const mocks = vi.hoisted(() => ({ home: '', run: vi.fn(), ptyLogin: vi.fn() }))
vi.mock('./connector-accounts', () => ({
  connectorAccountHome: (_settings: unknown, id: string) => ({
    provider: id.startsWith('claude:') ? 'claude' : 'codex',
    home: mocks.home,
    env: { CODEX_HOME: mocks.home, TEST_ACCOUNT: id }
  }),
  connectorConfigFile: (account: { provider: string; home: string }) =>
    join(account.home, account.provider === 'codex' ? 'config.toml' : '.claude.json')
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.run }))
vi.mock('./claude-connector-login-pty', () => ({ runClaudeConnectorLoginInPty: mocks.ptyLogin }))
vi.mock('./codex-connector-status', () => ({
  checkCodexConnector: () => Promise.resolve('signed-in')
}))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => '/bin/codex',
  resolveClaudeCommand: () => '/bin/claude',
  withCliRuntimeOnPath: (_program: string, env: unknown) => env
}))
import { ConnectorService } from './connector-service'

describe('account connector operations', () => {
  let service: ConnectorService
  beforeEach(() => {
    mocks.home = mkdtempSync(join(tmpdir(), 'connector-test-'))
    mocks.run.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    mocks.ptyLogin.mockReset().mockResolvedValue({ code: 0, timedOut: false })
    service = new ConnectorService(() => ({}) as GlobalSettings)
  })
  afterEach(() => rmSync(mocks.home, { recursive: true, force: true }))

  it('does not expose configuration secrets and refuses invalid files without overwriting them', async () => {
    writeFileSync(
      join(mocks.home, 'config.toml'),
      '[mcp_servers.docs]\nurl="https://example.com/mcp?token=secret"\n[mcp_servers.docs.http_headers]\nAuthorization="Bearer secret"\n'
    )
    expect(await service.list('codex:one')).toEqual([
      { name: 'docs', transport: 'http', enabled: true }
    ])
    writeFileSync(join(mocks.home, 'config.toml'), 'invalid = [')
    await expect(
      service.add('codex:one', { name: 'new', transport: 'http', url: 'https://example.com/mcp' })
    ).rejects.toThrow('configuration is invalid')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('targets the requested account and keeps local command arguments out of a shell', async () => {
    await service.add('codex:two', {
      name: 'local',
      transport: 'stdio',
      command: '/path with spaces/server',
      args: ['$(echo secret)']
    })
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/codex',
        args: ['mcp', 'add', 'local', '--', '/path with spaces/server', '$(echo secret)'],
        env: { CODEX_HOME: mocks.home, TEST_ACCOUNT: 'codex:two' },
        terminationBarrier: true
      })
    )
  })

  it('writes Claude user scope and rejects duplicate connector names', async () => {
    writeFileSync(join(mocks.home, '.claude.json'), '{}')
    await service.add('claude:one', {
      name: 'docs',
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    expect(mocks.run.mock.calls[0][0].args.slice(0, 5)).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'user',
      'docs'
    ])
    writeFileSync(
      join(mocks.home, '.claude.json'),
      JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } })
    )
    await expect(
      service.add('claude:one', { name: 'docs', transport: 'http', url: 'https://other.com/mcp' })
    ).rejects.toThrow('already exists')
  })

  it('distinguishes Codex authentication from verified connection health', async () => {
    writeFileSync(
      join(mocks.home, 'config.toml'),
      '[mcp_servers.docs]\nurl="https://example.com/mcp"'
    )
    mocks.run.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ name: 'docs', auth_status: 'o_auth' }])
    })
    expect(await service.action('codex:one', 'docs', 'check')).toBe('signed-in')
  })

  it('does not leak provider credentials through errors or run overlapping account mutations', async () => {
    mocks.run.mockResolvedValueOnce({ code: 1, stderr: 'Authorization: Bearer secret' })
    await expect(
      service.add('codex:one', { name: 'docs', transport: 'http', url: 'https://example.com/mcp' })
    ).rejects.toThrow('Setup did not finish')
    let release!: (result: unknown) => void
    mocks.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = service.add('codex:one', {
      name: 'docs',
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    await vi.waitFor(() => expect(release).toBeDefined())
    await expect(
      service.add('codex:one', { name: 'other', transport: 'http', url: 'https://example.com/mcp' })
    ).rejects.toThrow('Another connector operation')
    release({ code: 0, stdout: '' })
    await pending
  })

  it('signs Claude connectors in through a terminal and Codex connectors through a pipe', async () => {
    writeFileSync(
      join(mocks.home, '.claude.json'),
      JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp' } } })
    )
    mocks.run.mockResolvedValue({ code: 0, stdout: 'Status: ✔ Connected' })
    expect(await service.action('claude:one', 'docs', 'login')).toBe('connected')
    expect(mocks.ptyLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/claude',
        name: 'docs',
        env: { CODEX_HOME: mocks.home, TEST_ACCOUNT: 'claude:one' }
      })
    )
    expect(mocks.run.mock.calls.map(([call]) => call.args)).toEqual([['mcp', 'get', 'docs']])

    mocks.ptyLogin.mockResolvedValueOnce({ code: 1, timedOut: false })
    await expect(service.action('claude:one', 'docs', 'login')).rejects.toThrow(
      'could not complete'
    )
    mocks.ptyLogin.mockResolvedValueOnce({ code: null, timedOut: true })
    await expect(service.action('claude:one', 'docs', 'login')).rejects.toThrow('timed out')

    writeFileSync(
      join(mocks.home, 'config.toml'),
      '[mcp_servers.docs]\nurl="https://example.com/mcp"'
    )
    mocks.run.mockClear()
    mocks.ptyLogin.mockClear()
    await service.action('codex:one', 'docs', 'login')
    expect(mocks.ptyLogin).not.toHaveBeenCalled()
    expect(mocks.run.mock.calls[0][0].args).toEqual(['mcp', 'login', 'docs'])
  })
})
