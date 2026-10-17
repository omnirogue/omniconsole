import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readManagedSessionToolsFiles } from './managed-session-tools-files'
import { managedProviderDefaults, prepareManagedSessionTools } from './managed-session-tools'

const homes: string[] = []
const nativeOperationId = '1791410000000-0123456789abcdef0123456789abcdef'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-tools-'))
  homes.push(home)
  const state = join(home, 'state')
  const root = join(state, 'session-tools')
  const operation = join(root, 'ais_fixture')
  mkdirSync(operation, { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.config/omni'), { recursive: true, mode: 0o700 })
  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  write(join(home, '.config/omni/ai-operations-host.json'), { state_dir: state })
  writeFileSync(join(root, 'native_tools_mcp.py'), '# managed shim\n', { mode: 0o700 })
  write(join(operation, 'config.json'), { token: 'private-test-only' })
  const descriptor = {
    schema: 'native-session-tools.v1',
    operation_id: 'ais_fixture',
    native_operation_id: nativeOperationId,
    provider: 'claude',
    command: '/usr/bin/python3',
    args: [join(root, 'native_tools_mcp.py'), join(operation, 'config.json')],
    principal: { clerk_user_id: 'user_eve', employee_id: 'emp_eve' }
  }
  const file = join(operation, 'descriptor.json')
  write(file, descriptor)
  return { home, root, operation, descriptor, file, write }
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('managed tool attachment files', () => {
  it('binds exact native operation/provider, fixed paths and host-owned principal', () => {
    const f = fixture()
    const files = readManagedSessionToolsFiles(
      f.file,
      { nativeOperationId, provider: 'claude' },
      f.home
    )
    expect(files.descriptor.principal.employee_id).toBe('emp_eve')
    expect(() => files.assertCurrent()).not.toThrow()
    expect(() =>
      readManagedSessionToolsFiles(
        f.file,
        { nativeOperationId: `${nativeOperationId}x`, provider: 'claude' },
        f.home
      )
    ).toThrow()
    expect(() =>
      readManagedSessionToolsFiles(f.file, { nativeOperationId, provider: 'codex' }, f.home)
    ).toThrow()
  })

  it.each(['claude', 'codex'])(
    'binds an auto descriptor to the routed %s without changing its private file',
    (provider) => {
      const f = fixture()
      f.write(f.file, { ...f.descriptor, provider: 'auto' })
      const before = readFileSync(f.file)
      const files = readManagedSessionToolsFiles(f.file, { nativeOperationId, provider }, f.home)
      expect(files.descriptor.provider).toBe(provider)
      expect(readFileSync(f.file)).toEqual(before)
      expect(() => files.assertCurrent()).not.toThrow()
      expect(() =>
        readManagedSessionToolsFiles(f.file, { nativeOperationId, provider: 'auto' }, f.home)
      ).toThrow()
    }
  )

  it.each(['world-readable', 'symlink', 'wrong-location', 'extra-field'])(
    'refuses %s descriptors',
    (attack) => {
      const f = fixture()
      let file = f.file
      if (attack === 'world-readable') {
        chmodSync(file, 0o644)
      }
      if (attack === 'symlink') {
        rmSync(file)
        symlinkSync(join(f.operation, 'config.json'), file)
      }
      if (attack === 'wrong-location') {
        file = join(f.operation, 'other.json')
        f.write(file, f.descriptor)
      }
      if (attack === 'extra-field') {
        f.write(file, { ...f.descriptor, url: 'https://untrusted.invalid' })
      }
      expect(() =>
        readManagedSessionToolsFiles(file, { nativeOperationId, provider: 'claude' }, f.home)
      ).toThrow('managed_session_tools_file_untrusted')
    }
  )

  it('fences descriptor and shim changes while allowing protected token renewal', () => {
    const f = fixture()
    const files = readManagedSessionToolsFiles(
      f.file,
      { nativeOperationId, provider: 'claude' },
      f.home
    )
    f.write(join(f.operation, 'config.json'), { token: 'renewed-private-test' })
    expect(() => files.assertCurrent()).not.toThrow()
    files.writeMcpConfig({ mcpServers: {} })
    f.write(files.mcpConfigPath, { mcpServers: { injected: {} } })
    expect(() => files.assertCurrent()).toThrow('managed_session_tools_file_untrusted')
    files.writeMcpConfig({ mcpServers: {} })
    f.write(f.file, {
      ...f.descriptor,
      principal: { clerk_user_id: 'user_other', employee_id: 'emp_other' }
    })
    expect(() => files.assertCurrent()).toThrow('managed_session_tools_file_untrusted')
  })
})

describe.skipIf(process.platform === 'win32')('managed provider configuration', () => {
  it('keeps Claude defaults and auth home; seeds only the initial session', async () => {
    const f = fixture()
    const result = await prepareManagedSessionTools(
      {
        file: f.file,
        nativeOperationId,
        provider: 'claude',
        agentArgs: '--dangerously-skip-permissions --effort high',
        commandOverride: undefined,
        selectedAccountEnv: { CLAUDE_CONFIG_DIR: '/verified/claude' },
        startupEnv: {},
        cwd: f.home
      },
      {
        readFiles: (file, expected) => readManagedSessionToolsFiles(file, expected, f.home),
        resolveProgram: () => '/verified/bin/claude',
        resolveExecutable: async (path) => ({
          executablePath: path,
          environment: {},
          assertCurrent: () => {}
        })
      }
    )
    expect(result.agentArgs).toContain('--dangerously-skip-permissions')
    expect(result.agentArgs).toContain('--strict-mcp-config')
    expect(result.agentArgs).not.toContain('--session-id')
    expect(result.seededProviderSessionId).toMatch(/^[a-f0-9-]{36}$/)
    const config = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8'))
    expect(config.mcpServers.omni_native.args).toEqual(f.descriptor.args)
    expect(JSON.stringify(config)).not.toContain('private-test-only')
  })

  it('disables every inherited Codex MCP and verifies the effective selected account configuration', async () => {
    const f = fixture()
    f.write(f.file, { ...f.descriptor, provider: 'codex' })
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify([
          { name: 'personal-tools', enabled: true },
          { name: 'already_off', enabled: false }
        ])
      })
      .mockResolvedValueOnce({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify([
          { name: 'personal-tools', enabled: false },
          { name: 'omni_native', enabled: true }
        ])
      })
    const result = await prepareManagedSessionTools(
      {
        file: f.file,
        nativeOperationId,
        provider: 'codex',
        agentArgs: '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="high"',
        commandOverride: undefined,
        selectedAccountEnv: { CODEX_HOME: '/verified/codex' },
        startupEnv: {},
        cwd: f.home
      },
      {
        readFiles: (file, expected) => readManagedSessionToolsFiles(file, expected, f.home),
        resolveProgram: () => '/verified/bin/codex',
        resolveExecutable: async (path) => ({
          executablePath: path,
          environment: {},
          assertCurrent: () => {}
        }),
        run
      }
    )
    expect(run.mock.calls).toHaveLength(2)
    expect(run.mock.calls[0][0].env.CODEX_HOME).toBe('/verified/codex')
    expect(run.mock.calls[0][0].cwd).toBe(f.home)
    expect(result.agentArgs).toContain('mcp_servers.personal-tools.enabled=false')
    expect(result.agentArgs).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(result.agentArgs).toContain('plugins')
    expect(result.agentArgs).not.toContain('private-test-only')
  })

  it.each([
    ['claude', '--mcp-config attacker.json'],
    ['claude', '--resume other'],
    ['codex', '-c mcp_servers.attacker.enabled=true'],
    ['codex', '--enable apps'],
    ['codex', '--cd /other-workspace']
  ] as const)('refuses %s conflicting defaults %s', (provider, args) => {
    expect(() => managedProviderDefaults(provider, args)).toThrow(
      'managed_session_tools_conflicting_defaults'
    )
  })
})
