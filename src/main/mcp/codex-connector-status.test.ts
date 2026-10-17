import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../codex/codex-app-server-session', () => ({
  runCodexAppServerSession: (_invocation: unknown, body: (rpc: unknown) => Promise<unknown>) =>
    body({ request: mocks.request })
}))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => '/bin/codex' }))
import { checkCodexConnector } from './codex-connector-status'

describe('Codex connection observations', () => {
  beforeEach(() => mocks.request.mockReset())
  it('reports authenticated but disconnected servers separately from connected ones', async () => {
    mocks.request.mockResolvedValueOnce({
      data: [{ name: 'docs', authStatus: 'oAuth', runtimeStatus: 'failed', toolsError: 'failed' }]
    })
    expect(await checkCodexConnector('/account', 'docs')).toBe('unavailable')
    mocks.request.mockResolvedValueOnce({
      data: [{ name: 'docs', authStatus: 'oAuth', runtimeStatus: null }]
    })
    expect(await checkCodexConnector('/account', 'docs')).toBe('signed-in')
    mocks.request.mockResolvedValueOnce({ data: [{ name: 'docs', runtimeStatus: 'connected' }] })
    expect(await checkCodexConnector('/account', 'docs')).toBe('connected')
    expect(mocks.request).toHaveBeenCalledWith('mcpServerStatus/list', {
      serverName: 'docs',
      limit: 100
    })
  })
  it('leaves failed, missing and unsupported observations unavailable', async () => {
    mocks.request.mockRejectedValueOnce(new Error('token secret'))
    expect(await checkCodexConnector('/account', 'docs')).toBe('unavailable')
    mocks.request.mockResolvedValueOnce({ data: [] })
    expect(await checkCodexConnector('/account', 'docs')).toBe('unavailable')
  })
})
