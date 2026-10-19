import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
const mocks = vi.hoisted(() => ({ sync: vi.fn(), panes: vi.fn(() => []) }))
vi.mock('../mcp/connector-service', () => ({
  ConnectorService: class {
    syncOmnisiTeam = mocks.sync
  }
}))
vi.mock('./runtime-panes', () => ({
  readTeamPanes: mocks.panes,
  deliverTeamDirective: vi.fn(),
  assertTeamPaneReady: vi.fn(),
  teamReceiptKey: (id: string) => id
}))
import { OmnisiTeamService } from './service'
import { hasTeamLaunchConnection } from './launch'

let directory: string
let service: OmnisiTeamService
const key = 'osc1.obviously-fake-test-key'
let settings: { experimentalOmnisiTeam?: boolean }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'omnisi-service-'))
  settings = {}
  mocks.sync.mockReset().mockResolvedValue(undefined)
  mocks.panes.mockClear()
  const store = {
    getSettings: () => settings,
    updateSettings: (next: object) => {
      Object.assign(settings, next)
    }
  }
  service = new OmnisiTeamService(directory, store as unknown as Store, {} as OrcaRuntimeService)
  let sealed = ''
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => {
      sealed = value
      return Buffer.from('fake-os-sealed')
    },
    decryptString: () => sealed
  })
})
afterEach(async () => {
  await service.stop()
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  _resetSecretStoreForTests()
})
describe('team connection lifecycle', () => {
  it('does nothing when disabled, including no config, network or pane changes', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await service.start()).toEqual({ enabled: false, connected: false })
    await expect(service.connect('https://team.example/mcp', key)).rejects.toThrow('Enable OmniSI')
    await service.enable(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(mocks.panes).not.toHaveBeenCalled()
    expect(readdirSync(directory)).toEqual([])
    expect(hasTeamLaunchConnection()).toBe(false)
  })
  it('connects via a fake MCP endpoint and disconnects without leaking the key to configs or logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        expect(options.headers.Authorization).toBe(`Bearer ${key}`)
        const call = JSON.parse(options.body)
        if (!call.id) {
          return new Response(null, { status: 202 })
        }
        const result =
          call.method === 'initialize'
            ? { protocolVersion: '2025-03-26' }
            : {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ org_id: 'org-fake', person_id: 'person-fake' })
                  }
                ]
              }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }), {
          headers: { 'Content-Type': 'application/json' }
        })
      })
    )
    await service.enable(true)
    expect(await service.connect('https://team.example/mcp', key)).toEqual({
      enabled: true,
      connected: true,
      server: 'https://team.example/mcp',
      team: 'org-fake'
    })
    expect(mocks.sync).toHaveBeenCalledWith('https://team.example/mcp', expect.any(Function))
    expect(JSON.stringify(mocks.sync.mock.calls)).not.toContain(key)
    expect(readFileSync(join(directory, 'connection.sealed'), 'utf8')).not.toContain(key)
    expect(hasTeamLaunchConnection()).toBe(true)
    expect(await service.disconnect()).toEqual({ enabled: true, connected: false })
    expect(mocks.sync).toHaveBeenLastCalledWith(null)
    expect(readdirSync(directory)).toEqual([])
    expect(hasTeamLaunchConnection()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
