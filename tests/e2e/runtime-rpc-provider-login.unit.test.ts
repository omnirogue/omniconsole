import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_LOGIN_METHODS } from '../../src/main/runtime/rpc/methods/provider-login'
import { callRuntimeRpc } from '../../src/renderer/src/runtime/runtime-rpc-client'

const id = 'd802496f-9d94-4a2f-bf58-8c239acccf66'
const requests = [
  ['accounts.login.start', { provider: 'claude', accountId: 'second-account', runtime: 'host' }],
  ['accounts.login.start', { provider: 'codex', runtime: 'wsl', wslDistro: 'Ubuntu' }],
  ['accounts.login.status', { id }],
  ['accounts.login.submitCode', { id, code: 'authorization-code' }],
  ['accounts.login.cancel', { id }]
] as const

afterEach(() => vi.unstubAllGlobals())

describe.each(['local', 'environment'] as const)('%s provider login requests', (kind) => {
  it.each(requests)('preserves the strict schema for %s (%j)', async (method, params) => {
    const schema = PROVIDER_LOGIN_METHODS.find((entry) => entry.name === method)!.params!
    const call = vi.fn(async (request: { params: unknown }) => ({
      id: 'test',
      ok: true,
      result: schema.parse(request.params),
      _meta: { runtimeId: 'test' }
    }))
    vi.stubGlobal('window', {
      api: { runtime: { call }, runtimeEnvironments: { call } }
    })
    const target = kind === 'local' ? { kind } : { kind, environmentId: 'remote' }
    await expect(
      callRuntimeRpc(target, method, params, {
        suppressFeatureInteraction: true,
        skipCompatibilityCheck: true
      })
    ).resolves.toEqual(params)
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ method, params }))
    expect(schema.safeParse({ ...params, unexpected: true }).success).toBe(false)
  })
})
