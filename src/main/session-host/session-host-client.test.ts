import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SessionHostClient,
  type SessionHostClientTransport
} from '../../shared/session-host-client'
import { SessionHostOwnerDirectory } from '../../shared/session-host-owner-directory'
import { SESSION_HOST_RPC } from '../../shared/session-host-protocol'
import {
  LEGACY_RELAY_PTY_CAPABILITIES,
  legacyRuntimeStatus,
  phase4RuntimeStatus
} from '../../shared/session-host-wire-fixtures'
import type { RpcContext } from '../runtime/rpc/core'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RelaySessionHostHandler } from '../../relay/session-host-relay-handler'
import type { MethodHandler } from '../../relay/dispatcher'
import {
  runtimeSessionHostTransport,
  sshSessionHostTransport
} from './session-host-client-transports'
import {
  handleRuntimeSessionHostCall,
  runtimeSessionHostStatus,
  setRuntimeSessionHostProcessForTests
} from './session-host-runtime'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  MAC_B,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from './session-host-test-fixture'

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  setRuntimeSessionHostProcessForTests(null)
  host.dispose()
})

type Calls = string[]

/** A Mac's paired connection to runtime `runtimeId`, through the real RPC entry point. */
function pairedMac(device: string, runtimeId: () => string, calls: Calls = []) {
  const runtime = { getRuntimeId: runtimeId } as RpcContext['runtime']
  return runtimeSessionHostTransport(async (method, params) => {
    calls.push(method)
    const meta = { runtimeId: runtimeId() }
    if (method === 'status.get') {
      const status = runtimeSessionHostStatus(runtimeId())
      return {
        id: '1',
        ok: true,
        _meta: meta,
        result: {
          runtimeId: runtimeId(),
          capabilities: status?.capabilities ?? [],
          ...(status ? { sessionHost: status.sessionHost } : {})
        }
      }
    }
    const result = await handleRuntimeSessionHostCall(method as never, params, {
      runtime,
      pairedDeviceId: device,
      clientCapabilities: [
        'session-control.owner.v1',
        'session-organization.host.v1',
        'session-transfer.remote-source.v1',
        'session-relocation.claude.v1',
        'session-relocation.codex.v1',
        'session-waits.remote.v1'
      ]
    })
    return { id: '1', ok: true, _meta: meta, result } as RuntimeRpcResponse<unknown>
  })
}

/** A Mac's SSH connection to a relay daemon, through the real relay handler. */
function sshMac(
  handlers: Map<string, MethodHandler>,
  capabilities: () => Record<string, unknown>,
  clientHostId: string
) {
  return sshSessionHostTransport({
    clientHostId,
    connection: () => 'ssh:build',
    mux: () => ({
      request: async (method, params) => {
        if (method === 'pty.getCapabilities') {
          return { ...LEGACY_RELAY_PTY_CAPABILITIES, ...capabilities() }
        }
        const handler = handlers.get(method)
        if (!handler) {
          throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
        }
        return await handler(params ?? {}, { clientId: 1, isStale: () => false })
      }
    })
  })
}

async function pairedRuntime(incarnation = 'runtime-1') {
  const executor = new FakeSessionHostExecutor()
  const process = testHostProcess({ root: host.root, incarnation, executor })
  setRuntimeSessionHostProcessForTests(process)
  const service = await process.service()
  const { conversationId } = await adoptTestConversation(service)
  return { executor, process, service, conversationId }
}

describe('two Macs, one execution host', () => {
  it('distinct operation ids for one idle turn, sent at once from two Macs: one continuation', async () => {
    const { executor, conversationId } = await pairedRuntime()
    const studio = new SessionHostClient(pairedMac('studio', () => 'runtime-1'))
    const laptop = new SessionHostClient(pairedMac('laptop', () => 'runtime-1'))
    const [a, b] = await Promise.all([
      studio.execute(continueRequest(1, conversationId)),
      laptop.execute(continueRequest(2, conversationId, { origin: MAC_B }))
    ])
    const outcomes = [a, b].map((reply) =>
      reply.status === 'ok' ? reply.operation.state : reply.refusal.code
    )
    expect(outcomes.sort()).toEqual(['completed', 'refused'])
    expect(executor.dispatched).toHaveLength(1)
  })

  it('an alias (the relay and the paired runtime on one account) resolves to one owner', async () => {
    const { executor, conversationId } = await pairedRuntime()
    const handlers = new Map<string, MethodHandler>()
    const relayProcess = testHostProcess({
      root: host.root,
      incarnation: 'relay-1',
      kind: 'ssh-relay',
      executor: new FakeSessionHostExecutor()
    })
    const relay = new RelaySessionHostHandler(
      {
        onRequest: (m, h) => void handlers.set(m, h),
        onClientDetached: () => () => {},
        isPrimaryClient: () => true
      },
      relayProcess
    )
    await relayProcess.service()
    const overSsh = new SessionHostClient(
      sshMac(handlers, () => relay.ptyCapabilities(), 'host_0a1b2c3d4e5f60718293a4b5c6d7e8f9')
    )
    const overPairing = new SessionHostClient(pairedMac('studio', () => 'runtime-1'))
    const directory = new SessionHostOwnerDirectory()
    for (const [connection, client] of [
      ['ssh:build', overSsh],
      ['paired:studio', overPairing]
    ] as const) {
      const negotiation = await client.negotiate()
      directory.noteConnection(connection, negotiation?.peer ?? null)
      const observed = await client.observe()
      directory.noteObservation(observed.status === 'ok' ? observed : null)
    }
    const hostId = directory.hostOf('ssh:build')
    expect(hostId).toBe(directory.hostOf('paired:studio'))
    expect(directory.connectionsOf(hostId!).sort()).toEqual(['paired:studio', 'ssh:build'])
    expect(directory.ownerOf(conversationId)).toEqual({ hostId, ownerEpoch: 1 })
    // Only the process that runs it acts on it; the other path is refused, never run twice.
    const viaRelay = await overSsh.execute(continueRequest(1, conversationId))
    expect(viaRelay).toMatchObject({
      status: 'ok',
      operation: { state: 'refused', refusal: { code: 'ownership-conflict' } }
    })
    const viaRuntime = await overPairing.execute(continueRequest(2, conversationId))
    expect(viaRuntime).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
    expect(executor.dispatched).toHaveLength(1)
  })
})

describe('partitions and restarts', () => {
  it('an unreachable owner stays the owner and reads unverifiable; nothing is sent elsewhere', async () => {
    const { conversationId } = await pairedRuntime()
    let reachable = true
    const calls: Calls = []
    const inner = pairedMac('studio', () => 'runtime-1', calls)
    const flaky: SessionHostClientTransport = {
      ...inner,
      probe: () => (reachable ? inner.probe() : Promise.reject(new Error('timeout'))),
      call: (method, params) =>
        reachable ? inner.call(method, params) : Promise.reject(new Error('socket closed'))
    }
    const client = new SessionHostClient(flaky)
    const directory = new SessionHostOwnerDirectory()
    const first = await client.observe()
    directory.noteObservation(first.status === 'ok' ? first : null)
    const owner = directory.ownerOf(conversationId)
    expect(directory.verdictOf(conversationId, first.status === 'ok' ? first : null)).toBe('live')
    reachable = false
    const lost = await client.observe()
    expect(lost).toMatchObject({ status: 'refused', refusal: { code: 'host-unreachable' } })
    directory.noteObservation(lost.status === 'ok' ? lost : null)
    expect(directory.ownerOf(conversationId)).toEqual(owner)
    expect(directory.verdictOf(conversationId, null)).toBe('unverifiable')
    const continued = await client.execute(continueRequest(1, conversationId))
    expect(continued).toMatchObject({ status: 'refused', refusal: { code: 'host-unreachable' } })
    // Another host echoing the same conversation at the same epoch never takes it over.
    directory.noteObservation({
      status: 'ok',
      host: { hostId: 'host_f06cee505b3645bab00814b2f849e567', incarnation: 'x' },
      sessions: [{ ...(first.status === 'ok' ? first.sessions[0]! : ({} as never)) }]
    })
    expect(directory.ownerOf(conversationId)).toEqual(owner)
  })

  it('re-probes after the host restarts, before anything else is sent', async () => {
    const { conversationId } = await pairedRuntime()
    let runtimeId = 'runtime-1'
    const calls: Calls = []
    const client = new SessionHostClient(pairedMac('studio', () => runtimeId, calls))
    await client.observe()
    expect(calls).toEqual(['status.get', SESSION_HOST_RPC.observe])
    runtimeId = 'runtime-2'
    await client.observe()
    // The reply stamped with runtime-2 made the negotiation stale: the next call probes first.
    await client.execute(continueRequest(1, conversationId))
    expect(calls.slice(2)).toEqual([SESSION_HOST_RPC.observe, 'status.get'])
  })
})

describe('mixed versions', () => {
  it('against a host that predates Phase 4 nothing is sent, over either transport', async () => {
    const calls: Calls = []
    const oldRuntime = new SessionHostClient({
      probe: async () =>
        (
          await import('../../shared/session-host-capabilities')
        ).readRuntimeSessionHostAdvertisement(legacyRuntimeStatus()),
      call: async (method) => (calls.push(method), { ok: true, result: null }),
      connection: () => null
    })
    const refused = await oldRuntime.execute(
      continueRequest(1, 'conv_2437e543a0344939857f71286dd9b814')
    )
    expect(refused).toMatchObject({
      status: 'refused',
      refusal: { code: 'unsupported-capability' }
    })
    const oldRelay = new SessionHostClient(
      sshMac(new Map(), () => ({}), 'host_0a1b2c3d4e5f60718293a4b5c6d7e8f9')
    )
    expect(await oldRelay.observe()).toMatchObject({ refusal: { code: 'unsupported-capability' } })
    expect(calls).toEqual([])
  })

  it('a host that advertises but lacks the method answers with an explicit refusal, not a fallback', async () => {
    const client = new SessionHostClient(
      runtimeSessionHostTransport(async (method) =>
        method === 'status.get'
          ? {
              id: '1',
              ok: true,
              _meta: { runtimeId: phase4RuntimeStatus().runtimeId },
              result: phase4RuntimeStatus()
            }
          : { id: '1', ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
      )
    )
    const reply = await client.observe()
    expect(reply).toMatchObject({ status: 'refused', refusal: { code: 'unsupported-capability' } })
  })
})
