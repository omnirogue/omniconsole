import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const PREFIXES = ['X-Orca', 'X-Omni', 'X-OmniConsole'] as const
const PANE = makePaneKey('tab-wire', '11111111-1111-4111-8111-111111111111')
const WORKTREE = 'wire café 日本語 😀'
const PAYLOAD = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'wire delivery' })
const METADATA = Buffer.from(
  [PANE, 'tab-wire', '', WORKTREE, 'production', '1'].join('\x1f')
).toString('base64')
type Delivered = { paneKey: string; worktreeId?: string; state: string; prompt?: string }

describe.each(['desktop', 'relay'] as const)('%s hook wire compatibility', (host) => {
  const cleanup: (() => void)[] = []

  afterEach(() => {
    cleanup
      .splice(0)
      .toReversed()
      .forEach((stop) => stop())
    vi.restoreAllMocks()
  })

  async function start(): Promise<{ port: number; token: string; delivered: () => Delivered[] }> {
    if (host === 'desktop') {
      const server = new AgentHookServer()
      cleanup.push(() => server.stop())
      await server.start({ env: 'production' })
      const env = server.buildPtyEnv()
      return {
        port: Number(env.ORCA_AGENT_HOOK_PORT),
        token: env.ORCA_AGENT_HOOK_TOKEN,
        delivered: () => server.getStatusSnapshot()
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'hook-wire-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const delivered: Delivered[] = []
    const server = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (envelope) => delivered.push({ ...envelope.payload, ...envelope })
    })
    cleanup.push(() => server.stop())
    await server.start()
    return { ...server.getCoordinates(), delivered: () => delivered }
  }

  async function post(port: number, headers: Record<string, string>): Promise<number> {
    return (
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: PAYLOAD
      })
    ).status
  }

  it.each(PREFIXES)('delivers an existing %s client with its raw JSON metadata', async (prefix) => {
    const server = await start()
    expect(
      await post(server.port, {
        [`${prefix}-Agent-Hook-Token`]: server.token,
        [`${prefix}-Agent-Hook-Meta-Encoding`]: 'base64',
        [`${prefix}-Agent-Hook-Meta`]: METADATA
      })
    ).toBe(204)
    expect(server.delivered()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        worktreeId: WORKTREE,
        state: 'working',
        prompt: 'wire delivery'
      })
    ])
  })

  it('accepts equal compatibility aliases without duplicating the event', async () => {
    const server = await start()
    const headers = Object.fromEntries(
      PREFIXES.flatMap((prefix) => [
        [`${prefix}-Agent-Hook-Token`, server.token],
        [`${prefix}-Agent-Hook-Meta-Encoding`, 'base64'],
        [`${prefix}-Agent-Hook-Meta`, METADATA]
      ])
    )
    expect(await post(server.port, headers)).toBe(204)
    expect(server.delivered()).toHaveLength(1)
    expect(server.delivered()[0].paneKey).toBe(PANE)
  })

  it.each(PREFIXES)('rejects an incorrect %s token even beside a valid alias', async (prefix) => {
    const server = await start()
    const headers = Object.fromEntries(
      PREFIXES.map((name) => [`${name}-Agent-Hook-Token`, server.token])
    )
    headers[`${prefix}-Agent-Hook-Token`] = 'incorrect-synthetic-token'
    expect(await post(server.port, headers)).toBe(403)
    expect(server.delivered()).toEqual([])
  })

  it('rejects missing authentication', async () => {
    const server = await start()
    expect(await post(server.port, {})).toBe(403)
    expect(server.delivered()).toEqual([])
  })

  it.each(PREFIXES)('rejects duplicate %s token fields on the actual HTTP wire', async (prefix) => {
    const server = await start()
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/hook/claude',
          method: 'POST',
          headers: [
            'Host',
            `127.0.0.1:${server.port}`,
            'Content-Type',
            'application/json',
            `${prefix}-Agent-Hook-Token`,
            server.token,
            `${prefix}-Agent-Hook-Token`,
            server.token
          ]
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(PAYLOAD)
    })
    expect(status).toBe(403)
    expect(server.delivered()).toEqual([])
  })

  it.each(['Meta', 'Meta-Encoding'])(
    'drops conflicting %s aliases before ingestion',
    async (field) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const server = await start()
      expect(
        await post(server.port, {
          'X-Orca-Agent-Hook-Token': server.token,
          'X-Orca-Agent-Hook-Meta': METADATA,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          [`X-Omni-Agent-Hook-${field}`]:
            field === 'Meta' ? Buffer.from('different pane').toString('base64') : 'plain'
        })
      ).toBe(204) // Preserve the hook listener's fail-open body-error acknowledgement.
      expect(server.delivered()).toEqual([])
    }
  )
})
