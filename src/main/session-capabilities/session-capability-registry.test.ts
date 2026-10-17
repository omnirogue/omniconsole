import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_CONFIG_CANDIDATES } from '../../shared/mcp-config'
import { MCP_CONFIG_INSPECTION_MAX_BYTES } from '../../shared/mcp-config-inspection-limits'
import {
  forgetSessionCapabilitiesForPane,
  getSessionCapabilitiesForPane,
  readMcpConfigCandidate,
  recordSessionCapabilitiesForPane,
  resetSessionCapabilityRegistryForTests
} from './session-capability-registry'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

describe('session capability registry', () => {
  let dir: string

  beforeEach(async () => {
    resetSessionCapabilityRegistryForTests()
    dir = await mkdtemp(path.join(tmpdir(), 'session-capabilities-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('probes real MCP files under the cwd and stores names keyed by pane', async () => {
    await mkdir(path.join(dir, '.cursor'))
    await writeFile(
      path.join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } }
      })
    )
    await recordSessionCapabilitiesForPane(PANE, {
      cwd: dir,
      env: { REPLICATE_API_TOKEN: 'r8_value' }
    })
    const stored = getSessionCapabilitiesForPane(PANE)
    expect(stored?.host).toBe('local')
    expect(stored?.mcpServers).toEqual([{ name: 'linear', source: 'Cursor' }])
    expect(stored?.providers).toContainEqual({
      provider: 'replicate',
      envNames: ['REPLICATE_API_TOKEN']
    })
    expect(JSON.stringify(stored)).not.toContain('r8_value')
  })

  it('records SSH launches as unknown', async () => {
    await recordSessionCapabilitiesForPane(PANE, {
      cwd: '/home/remote',
      env: { OPENAI_API_KEY: 'x' },
      connectionId: 'ssh-1'
    })
    expect(getSessionCapabilitiesForPane(PANE)).toMatchObject({
      host: 'remote',
      providers: 'unknown',
      mcpServers: 'unknown'
    })
  })

  it('keeps only the newest probe when an older one settles last', async () => {
    let releaseSlow: () => void = () => {}
    const slowContent = new Promise<string>((resolve) => {
      releaseSlow = () => resolve('{"mcpServers":{"stale":{"command":"x"}}}')
    })
    const slow = recordSessionCapabilitiesForPane(
      PANE,
      { cwd: '/slow', env: {} },
      () => slowContent
    )
    await recordSessionCapabilitiesForPane(PANE, { cwd: '/fast', env: {} }, async () => null)
    releaseSlow()
    await slow
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toEqual([])
  })

  it('records a refused MCP read as unknown rather than as no servers', async () => {
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} }, async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toBe('unknown')
  })

  it('rejects an unreadable config file but reads a missing one as absent', async () => {
    const filePath = path.join(dir, '.mcp.json')
    await writeFile(filePath, '{"mcpServers":{"github":{"command":"x"}}}')
    await chmod(filePath, 0o000)
    const candidate = MCP_CONFIG_CANDIDATES[0]!
    // Why: root ignores the mode bits, so the refusal this asserts cannot happen there.
    if (process.getuid?.() !== 0) {
      await expect(readMcpConfigCandidate(dir, candidate)).rejects.toThrow()
    }
    await chmod(filePath, 0o600)
    await expect(readMcpConfigCandidate(path.join(dir, 'nowhere'), candidate)).resolves.toBeNull()
  })

  it('reports a config too large to inspect as unknown, never as no servers', async () => {
    await writeFile(
      path.join(dir, '.mcp.json'),
      Buffer.alloc(MCP_CONFIG_INSPECTION_MAX_BYTES + 1, 32)
    )
    await expect(readMcpConfigCandidate(dir, MCP_CONFIG_CANDIDATES[0]!)).rejects.toThrow(
      /inspection size limit/
    )
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} })
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toBe('unknown')
  })

  it('treats a directory occupying the config path as unknown, never as absent', async () => {
    await mkdir(path.join(dir, '.mcp.json'))
    await expect(readMcpConfigCandidate(dir, MCP_CONFIG_CANDIDATES[0]!)).rejects.toThrow(
      /not a regular file/
    )
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} })
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toBe('unknown')
  })

  it('reports malformed and empty configs as unknown rather than as no servers', async () => {
    await writeFile(path.join(dir, '.mcp.json'), '{not-json')
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} })
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toBe('unknown')

    await writeFile(path.join(dir, '.mcp.json'), '')
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} })
    expect(getSessionCapabilitiesForPane(PANE)?.mcpServers).toBe('unknown')
  })

  it('ignores panes without a key and forgets torn-down panes', async () => {
    await recordSessionCapabilitiesForPane(null, { cwd: dir, env: {} })
    await recordSessionCapabilitiesForPane(PANE, { cwd: dir, env: {} })
    forgetSessionCapabilitiesForPane(PANE)
    expect(getSessionCapabilitiesForPane(PANE)).toBeNull()
  })
})
