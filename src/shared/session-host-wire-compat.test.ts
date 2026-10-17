import { describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  readClientSessionHostDeclaration,
  readRelaySessionHostAdvertisement,
  readRuntimeSessionHostAdvertisement,
  type SessionHostAdvertisement
} from './session-host-capabilities'
import {
  negotiateSessionHostCapabilities,
  requireSessionHostMethod,
  type SessionHostNegotiationSide
} from './session-host-negotiation'
import { SESSION_HOST_RPC } from './session-host-protocol'
import { requireRelocationBundleCapability } from './session-host-relocation-bundle'
import { isSessionHostMethodMissing, sessionHostMissingMethodRefusal } from './session-host-refusal'
import {
  LEGACY_RELAY_PTY_CAPABILITIES,
  legacyClientCapabilities,
  legacyRuntimeStatus,
  phase4ClientCapabilities,
  phase4RelayPtyCapabilities,
  phase4RuntimeStatus
} from './session-host-wire-fixtures'

const METHODS = Object.values(SESSION_HOST_RPC)
const negotiate = (
  side: SessionHostNegotiationSide,
  peer: SessionHostAdvertisement,
  local: readonly string[]
) => negotiateSessionHostCapabilities({ side, local, peer })

describe('session host control across mixed versions', () => {
  it('new client against old paired host: every method is refused before it is called', () => {
    const negotiation = negotiate(
      'client',
      readRuntimeSessionHostAdvertisement(legacyRuntimeStatus()),
      SESSION_HOST_CAPABILITIES
    )
    for (const method of METHODS) {
      expect(requireSessionHostMethod(negotiation, method)).toMatchObject({
        code: 'unsupported-capability'
      })
    }
  })

  it('new client against old relay: the pinned pre-Phase-4 answer negotiates nothing', () => {
    const negotiation = negotiate(
      'client',
      readRelaySessionHostAdvertisement(LEGACY_RELAY_PTY_CAPABILITIES),
      SESSION_HOST_CAPABILITIES
    )
    expect(negotiation.peerStatus).toBe('absent')
    expect(negotiation.agreed).toEqual([])
  })

  it('new client against old host that is called anyway: method-not-found is an explicit refusal', () => {
    for (const error of [{ code: 'method_not_found' }, { code: -32601 }]) {
      expect(isSessionHostMethodMissing(error)).toBe(true)
    }
    for (const error of [
      { code: 'invalid_argument' },
      { code: -32602 },
      new Error('timeout'),
      null
    ]) {
      expect(isSessionHostMethodMissing(error)).toBe(false)
    }
    const refusal = sessionHostMissingMethodRefusal(
      SESSION_HOST_RPC.execute,
      SESSION_CONTROL_OWNER_CAPABILITY
    )
    expect(refusal).toMatchObject({
      code: 'unsupported-capability',
      capability: SESSION_CONTROL_OWNER_CAPABILITY
    })
    expect(refusal.message).toContain('Nothing was sent')
  })

  it('old client against new host: the host refuses control to a client that declared none of it', () => {
    const negotiation = negotiate(
      'host',
      readClientSessionHostDeclaration(legacyClientCapabilities()),
      SESSION_HOST_CAPABILITIES
    )
    expect(negotiation.agreed).toEqual([])
    for (const method of METHODS) {
      expect(requireSessionHostMethod(negotiation, method)?.message).toContain(
        'the session stays visible to it'
      )
    }
  })

  it('old client against new host: the new answers only add; every field an old client reads is unchanged', () => {
    const relay = phase4RelayPtyCapabilities()
    for (const [field, value] of Object.entries(LEGACY_RELAY_PTY_CAPABILITIES)) {
      expect(relay).toHaveProperty(field, value)
    }
    const legacy = legacyRuntimeStatus()
    const current = phase4RuntimeStatus()
    expect(current.runtimeId).toBe(legacy.runtimeId)
    expect(current.capabilities).toEqual(expect.arrayContaining(legacy.capabilities))
  })

  it('new client against new host: every capability agrees over both transports, in both directions', () => {
    for (const advertisement of [
      readRuntimeSessionHostAdvertisement(phase4RuntimeStatus()),
      readRelaySessionHostAdvertisement(phase4RelayPtyCapabilities())
    ]) {
      expect(negotiate('client', advertisement, SESSION_HOST_CAPABILITIES).agreed).toEqual(
        SESSION_HOST_CAPABILITIES
      )
    }
    const host = negotiate(
      'host',
      readClientSessionHostDeclaration(phase4ClientCapabilities()),
      SESSION_HOST_CAPABILITIES
    )
    expect(host.agreed).toEqual(SESSION_HOST_CAPABILITIES)
  })

  it('new client against a partially upgraded host: only what both have is usable', () => {
    const negotiation = negotiate(
      'client',
      readRuntimeSessionHostAdvertisement(phase4RuntimeStatus([SESSION_CONTROL_OWNER_CAPABILITY])),
      SESSION_HOST_CAPABILITIES
    )
    expect(requireSessionHostMethod(negotiation, SESSION_HOST_RPC.execute)).toBeNull()
    expect(requireSessionHostMethod(negotiation, SESSION_HOST_RPC.history)).toMatchObject({
      code: 'unsupported-capability'
    })
    expect(requireSessionHostMethod(negotiation, SESSION_HOST_RPC.waitStatus)).toMatchObject({
      code: 'unsupported-capability'
    })
  })

  it('a host that relocates but cannot move bundles (a B1/C-era build) is refused its bundle calls', () => {
    const negotiation = negotiate(
      'client',
      readRuntimeSessionHostAdvertisement(
        phase4RuntimeStatus([
          SESSION_CONTROL_OWNER_CAPABILITY,
          SESSION_RELOCATION_CLAUDE_CAPABILITY
        ])
      ),
      SESSION_HOST_CAPABILITIES
    )
    for (const method of [SESSION_HOST_RPC.bundleRead, SESSION_HOST_RPC.bundleWrite]) {
      expect(requireSessionHostMethod(negotiation, method)).toMatchObject({
        code: 'unsupported-capability',
        capability: SESSION_RELOCATION_BUNDLE_CAPABILITY
      })
    }
    const both = negotiate(
      'client',
      readRuntimeSessionHostAdvertisement(
        phase4RuntimeStatus([
          SESSION_CONTROL_OWNER_CAPABILITY,
          SESSION_RELOCATION_CLAUDE_CAPABILITY,
          SESSION_RELOCATION_BUNDLE_CAPABILITY
        ])
      ),
      SESSION_HOST_CAPABILITIES
    )
    expect(requireSessionHostMethod(both, SESSION_HOST_RPC.bundleWrite)).toBeNull()
    expect(requireRelocationBundleCapability(both, 'claude')).toBeNull()
    expect(requireRelocationBundleCapability(both, 'codex')).toMatchObject({
      code: 'unsupported-capability'
    })
  })
})
