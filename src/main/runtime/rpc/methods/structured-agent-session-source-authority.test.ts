import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { structuredCallerFor } from './structured-agent-session-gate'

describe('structured source user authority', () => {
  it('derives launch actors from host transport identity', () => {
    const pairedDeviceId = '44444444-4444-4444-8444-444444444444'
    expect(
      structuredCallerFor(
        { clientKind: 'runtime', pairedDeviceId } as RpcContext,
        'agent-session-create'
      ).launchCause
    ).toEqual({
      trigger: 'agent-session-create',
      actor: { kind: 'paired-device', deviceId: pairedDeviceId, clientKind: 'runtime' }
    })
    expect(
      structuredCallerFor({ clientId: 'desktop-renderer' } as RpcContext, 'agent-session-create')
        .launchCause
    ).toEqual({ trigger: 'agent-session-create', actor: { kind: 'renderer' } })
  })

  it('requires authenticated renderer or paired UI transport identity', () => {
    for (const context of [
      { clientId: 'desktop-renderer' },
      { clientKind: 'mobile', pairedDeviceId: 'paired-phone' },
      { clientKind: 'runtime', pairedDeviceId: 'paired-desktop' }
    ]) {
      expect(structuredCallerFor(context as RpcContext).userSourceAuthority).toBe(true)
    }
  })

  it('does not promote local CLI, unpaired clients, or agent claims to human authority', () => {
    for (const context of [
      {},
      { clientId: 'cli' },
      { clientKind: 'runtime' },
      { clientKind: 'mobile' },
      { clientId: 'desktop-renderer', orchestrationCapability: 'worker' },
      {
        clientId: 'desktop-renderer',
        orchestrationCompatibilityEvidence: { agentSessionId: 'native' }
      }
    ]) {
      expect(structuredCallerFor(context as RpcContext).userSourceAuthority).toBeUndefined()
    }
  })
})
