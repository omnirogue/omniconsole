import { describe, expect, it } from 'vitest'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  readClientSessionHostDeclaration,
  readRelaySessionHostAdvertisement,
  readRuntimeSessionHostAdvertisement
} from './session-host-capabilities'
import {
  negotiateSessionHostCapabilities,
  requireSessionHostAction,
  requireSessionHostCapability,
  requireSessionHostMethod
} from './session-host-negotiation'
import {
  SESSION_HOST_ACTIONS,
  SESSION_HOST_RPC,
  sessionHostActionCapability
} from './session-host-protocol'
import {
  FIXTURE_HOST,
  LEGACY_RELAY_PTY_CAPABILITIES,
  phase4RelayPtyCapabilities,
  phase4RuntimeStatus
} from './session-host-wire-fixtures'

const client = (advertised: unknown, local: readonly string[] = SESSION_HOST_CAPABILITIES) =>
  negotiateSessionHostCapabilities({
    side: 'client',
    local,
    peer: readRelaySessionHostAdvertisement(advertised),
    connection: 'conn-1'
  })
const binding = { peer: FIXTURE_HOST, connection: 'conn-1' }

describe('negotiateSessionHostCapabilities', () => {
  it('agrees on every capability when both sides have them', () => {
    const negotiation = client(phase4RelayPtyCapabilities())
    expect(negotiation.agreed).toEqual(SESSION_HOST_CAPABILITIES)
    expect(negotiation.gaps).toEqual([])
    expect(negotiation.peer).toEqual(FIXTURE_HOST)
    for (const capability of SESSION_HOST_CAPABILITIES) {
      expect(requireSessionHostCapability(negotiation, capability, binding)).toBeNull()
    }
  })

  it('refuses everything against a relay that predates Phase 4, with no fallback', () => {
    const negotiation = client(LEGACY_RELAY_PTY_CAPABILITIES)
    expect(negotiation.peerStatus).toBe('absent')
    expect(negotiation.agreed).toEqual([])
    const refusal = requireSessionHostCapability(negotiation, SESSION_CONTROL_OWNER_CAPABILITY)
    expect(refusal).toMatchObject({
      code: 'unsupported-capability',
      capability: SESSION_CONTROL_OWNER_CAPABILITY
    })
    expect(refusal?.message).toContain('predates session host control')
    expect(refusal?.message).toContain('nothing runs on this computer instead')
  })

  it('refuses a peer whose advertisement cannot be read, rather than guessing', () => {
    for (const sessionHost of [
      { capabilities: 'all' },
      { capabilities: [SESSION_CONTROL_OWNER_CAPABILITY] },
      null,
      7
    ]) {
      const negotiation = client({ ...LEGACY_RELAY_PTY_CAPABILITIES, sessionHost })
      expect(negotiation.peerStatus).toBe('malformed')
      expect(
        requireSessionHostCapability(negotiation, SESSION_CONTROL_OWNER_CAPABILITY)?.message
      ).toContain('unreadably')
    }
  })

  it('negotiates each capability independently and names the side that lacks it', () => {
    const negotiation = client(phase4RelayPtyCapabilities([SESSION_CONTROL_OWNER_CAPABILITY]))
    expect(negotiation.agreed).toEqual([SESSION_CONTROL_OWNER_CAPABILITY])
    expect(
      requireSessionHostCapability(negotiation, SESSION_ORGANIZATION_HOST_CAPABILITY)?.message
    ).toMatch(/^That computer's OmniConsole does not support session-organization\.host\.v1/)
    const localOnly = client(phase4RelayPtyCapabilities(), [SESSION_CONTROL_OWNER_CAPABILITY])
    expect(
      requireSessionHostCapability(localOnly, SESSION_WAITS_REMOTE_CAPABILITY)?.message
    ).toMatch(/^This OmniConsole does not support/)
  })

  it('drops a capability whose prerequisite is not agreed', () => {
    const negotiation = client(phase4RelayPtyCapabilities([SESSION_ORGANIZATION_HOST_CAPABILITY]))
    expect(negotiation.agreed).toEqual([])
    expect(negotiation.gaps).toContainEqual({
      capability: SESSION_ORGANIZATION_HOST_CAPABILITY,
      gap: 'prerequisite'
    })
    expect(
      requireSessionHostCapability(negotiation, SESSION_ORGANIZATION_HOST_CAPABILITY)?.message
    ).toContain(`needs ${SESSION_CONTROL_OWNER_CAPABILITY}`)
  })

  it('refuses a capability name this build does not know', () => {
    const negotiation = client(phase4RelayPtyCapabilities())
    for (const name of [
      'session-control.owner.v9',
      'session-control.owner',
      'terminal.multiplex.v1',
      ''
    ]) {
      expect(requireSessionHostCapability(negotiation, name)).toMatchObject({
        code: 'unknown-capability'
      })
    }
  })

  it('tells a newer peer apart from one that has nothing', () => {
    const negotiation = client(phase4RelayPtyCapabilities(['session-control.owner.v2']))
    expect(negotiation.unknownPeerCapabilities).toEqual(['session-control.owner.v2'])
    expect(
      requireSessionHostCapability(negotiation, SESSION_CONTROL_OWNER_CAPABILITY)?.message
    ).toContain('It speaks session-control.owner.v2')
  })

  it('asks for a new negotiation after a reconnect or a host restart', () => {
    const negotiation = client(phase4RelayPtyCapabilities())
    const restarted = {
      peer: { ...FIXTURE_HOST, incarnation: 'restarted-1' },
      connection: 'conn-1'
    }
    const reconnected = { peer: FIXTURE_HOST, connection: 'conn-2' }
    const otherHost = {
      peer: { ...FIXTURE_HOST, hostId: `host_${'e'.repeat(32)}` },
      connection: 'conn-1'
    }
    for (const current of [restarted, reconnected, otherHost]) {
      expect(
        requireSessionHostCapability(negotiation, SESSION_CONTROL_OWNER_CAPABILITY, current)
      ).toMatchObject({
        code: 'renegotiate'
      })
    }
  })

  it('reads a paired runtime’s status, and refuses one that advertises without its identity', () => {
    expect(readRuntimeSessionHostAdvertisement(phase4RuntimeStatus())).toEqual({
      status: 'advertised',
      capabilities: SESSION_HOST_CAPABILITIES,
      identity: FIXTURE_HOST
    })
    const { sessionHost: _identity, ...anonymous } = phase4RuntimeStatus()
    expect(readRuntimeSessionHostAdvertisement(anonymous).status).toBe('malformed')
    expect(readRuntimeSessionHostAdvertisement({ runtimeId: 'r' }).status).toBe('absent')
    expect(readRuntimeSessionHostAdvertisement({ capabilities: 'x' }).status).toBe('malformed')
  })

  it('refuses control to a client that declared nothing, keeping organization visible', () => {
    const host = negotiateSessionHostCapabilities({
      side: 'host',
      local: SESSION_HOST_CAPABILITIES,
      peer: readClientSessionHostDeclaration(undefined)
    })
    const refusal = requireSessionHostMethod(host, SESSION_HOST_RPC.execute)
    expect(refusal).toMatchObject({ code: 'unsupported-capability' })
    expect(refusal?.message).toMatch(/^The requesting OmniConsole predates session host control/)
    expect(refusal?.message).toContain('the session stays visible to it')
  })
})

describe('requireSessionHostAction', () => {
  it('maps every action to a known capability', () => {
    for (const action of SESSION_HOST_ACTIONS) {
      const capability = sessionHostActionCapability(action, 'claude')
      expect(SESSION_HOST_CAPABILITIES).toContain(capability)
    }
    expect(sessionHostActionCapability('relocate.stage')).toBeNull()
  })

  it('negotiates relocation per provider format', () => {
    const negotiation = client(
      phase4RelayPtyCapabilities([
        SESSION_CONTROL_OWNER_CAPABILITY,
        SESSION_RELOCATION_CLAUDE_CAPABILITY
      ])
    )
    expect(requireSessionHostAction(negotiation, 'relocate.stage', 'claude')).toBeNull()
    expect(requireSessionHostAction(negotiation, 'relocate.stage', 'codex')).toMatchObject({
      capability: SESSION_RELOCATION_CODEX_CAPABILITY
    })
    expect(requireSessionHostAction(negotiation, 'relocate.stage')).toMatchObject({
      code: 'unknown-capability'
    })
    expect(requireSessionHostAction(negotiation, 'transfer.prepare-source')).toMatchObject({
      capability: SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY
    })
    expect(requireSessionHostAction(negotiation, 'continue')).toBeNull()
  })
})
