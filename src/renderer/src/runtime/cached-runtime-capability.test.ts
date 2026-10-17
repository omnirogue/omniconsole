import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCacheForTests,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { runtimeEnvironmentHasCachedCapability } from './cached-runtime-capability'
const runtimeEnvironmentCall = vi.fn()
beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })
})
describe('optional launch metadata uses existing compatibility evidence', () => {
  it('a cold or pending cache never starts or awaits a status request', async () => {
    expect(
      runtimeEnvironmentHasCachedCapability('env-pending', 'terminal.launch-provenance.v1')
    ).toBe(false)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    let release!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const probing = runtimeEnvironmentSupportsCapability(
      'env-pending',
      'agent-session.host-authority.v1'
    )
    expect(
      runtimeEnvironmentHasCachedCapability('env-pending', 'terminal.launch-provenance.v1')
    ).toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    release({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-a',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: ['agent-session.host-authority.v1', 'terminal.launch-provenance.v1']
      }
    })
    await expect(probing).resolves.toBe(true)
    expect(
      runtimeEnvironmentHasCachedCapability('env-pending', 'terminal.launch-provenance.v1')
    ).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    clearRecentRuntimeCompatibilityFailure('env-pending', {
      runtimeId: 'replacement'
    } as RuntimeStatus)
    expect(
      runtimeEnvironmentHasCachedCapability('env-pending', 'terminal.launch-provenance.v1')
    ).toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })
  it('an older host adds no optional probe and keeps the existing single status/launch path', async () => {
    const methods: string[] = []
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      methods.push(method)
      return Promise.resolve({
        id: method,
        ok: true,
        result:
          method === 'status.get'
            ? {
                runtimeId: 'old-runtime',
                graphStatus: 'ready',
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                capabilities: []
              }
            : { terminal: { handle: 'legacy' } }
      })
    })
    await expect(
      runtimeEnvironmentSupportsCapability('env-legacy', 'agent-session.host-authority.v1')
    ).resolves.toBe(false)
    expect(
      runtimeEnvironmentHasCachedCapability('env-legacy', 'terminal.launch-provenance.v1')
    ).toBe(false)
    await callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-legacy' },
      'terminal.create',
      {},
      { skipCompatibilityCheck: true }
    )
    expect(methods).toEqual(['status.get', 'terminal.create'])
  })
})
