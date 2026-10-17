import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readRelaySessionHostAdvertisement,
  SESSION_HOST_CAPABILITIES
} from '../shared/session-host-capabilities'
import { SESSION_HOST_RELAY_DECLARE_METHOD } from '../shared/session-host-client-declaration'
import { SESSION_HOST_RPC } from '../shared/session-host-protocol'
import {
  LEGACY_RELAY_PTY_CAPABILITIES,
  phase4ClientCapabilities
} from '../shared/session-host-wire-fixtures'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from '../main/session-host/session-host-test-fixture'
import type { PtyConsumerCloseCause } from '../shared/pty-consumer-session-contract'
import type { MethodHandler, RequestContext } from './dispatcher'
import { RelaySessionHostHandler } from './session-host-relay-handler'

const CLIENT_HOST = 'host_0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const PRIMARY = 1
const SOCKET = 2

class FakeRelayDispatcher {
  readonly handlers = new Map<string, MethodHandler>()
  private readonly detached = new Set<(clientId: number, cause: PtyConsumerCloseCause) => void>()
  generation = new Map<number, number>()

  onRequest(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler)
  }

  onClientDetached(listener: (clientId: number, cause: PtyConsumerCloseCause) => void): () => void {
    this.detached.add(listener)
    return () => this.detached.delete(listener)
  }

  isPrimaryClient(clientId: number): boolean {
    return clientId === PRIMARY
  }

  detach(clientId: number): void {
    for (const listener of this.detached) {
      listener(clientId, 'local')
    }
  }

  reconnect(clientId: number): void {
    this.generation.set(clientId, (this.generation.get(clientId) ?? 0) + 1)
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    clientId = PRIMARY,
    authenticated = false
  ) {
    const generation = this.generation.get(clientId) ?? 0
    const context: RequestContext = {
      clientId,
      isStale: () => (this.generation.get(clientId) ?? 0) !== generation,
      sessionIdentity: {
        principal: authenticated ? 'relay-endpoint:1' : `unproved:${clientId}`,
        authenticated,
        allowSessionOwner: authenticated,
        authenticationKind: authenticated ? 'endpoint-credential' : 'unproved'
      }
    }
    return await this.handlers.get(method)!(params, context)
  }
}

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  host.dispose()
})

async function relay(executor: FakeSessionHostExecutor | null = new FakeSessionHostExecutor()) {
  const dispatcher = new FakeRelayDispatcher()
  const process = testHostProcess({
    root: host.root,
    incarnation: 'relay-1',
    kind: 'ssh-relay',
    ...(executor ? { executor } : {})
  })
  const handler = new RelaySessionHostHandler(dispatcher, process)
  const service = await process.service()
  const { conversationId } = await adoptTestConversation(service)
  return { dispatcher, handler, process, conversationId }
}

const declaration = { capabilities: phase4ClientCapabilities(), client: CLIENT_HOST }

describe('RelaySessionHostHandler', () => {
  it('serves the contract route set plus the declaration', async () => {
    const { dispatcher } = await relay()
    expect([...dispatcher.handlers.keys()].sort()).toEqual(
      [...Object.values(SESSION_HOST_RPC), SESSION_HOST_RELAY_DECLARE_METHOD].sort()
    )
  })

  it('adds nothing to pty.getCapabilities until something can be carried out', async () => {
    const { handler, process } = await relay(null)
    // Exactly the pinned answer of a relay released before Phase 4.
    expect({ ...handler.ptyCapabilities(), ...LEGACY_RELAY_PTY_CAPABILITIES }).toEqual(
      LEGACY_RELAY_PTY_CAPABILITIES
    )
    process.installExecutor(new FakeSessionHostExecutor())
    const read = readRelaySessionHostAdvertisement({
      ...LEGACY_RELAY_PTY_CAPABILITIES,
      ...handler.ptyCapabilities()
    })
    expect(read).toMatchObject({
      status: 'advertised',
      capabilities: SESSION_HOST_CAPABILITIES,
      identity: { incarnation: 'relay-1' }
    })
  })

  it('serves a declared connection, and asks a reconnected one to declare again', async () => {
    const { dispatcher, conversationId } = await relay()
    expect(await dispatcher.call(SESSION_HOST_RPC.observe, {})).toMatchObject({
      status: 'refused',
      refusal: { code: 'renegotiate' }
    })
    expect(await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, declaration)).toEqual({
      status: 'ok'
    })
    const done = await dispatcher.call(SESSION_HOST_RPC.execute, continueRequest(1, conversationId))
    expect(done).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
    dispatcher.reconnect(PRIMARY)
    expect(await dispatcher.call(SESSION_HOST_RPC.observe, {})).toMatchObject({
      refusal: { code: 'renegotiate' }
    })
    await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, declaration)
    const observed = await dispatcher.call(SESSION_HOST_RPC.observe, {})
    expect(observed).toMatchObject({ status: 'ok', sessions: [{ conversationId }] })
  })

  it('refuses a socket client that proved nothing, and serves an authenticated one', async () => {
    const { dispatcher } = await relay()
    expect(
      await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, declaration, SOCKET)
    ).toMatchObject({
      refusal: { code: 'provenance-required' }
    })
    expect(
      await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, declaration, SOCKET, true)
    ).toEqual({ status: 'ok' })
    expect(await dispatcher.call(SESSION_HOST_RPC.observe, {}, SOCKET, true)).toMatchObject({
      status: 'ok'
    })
    dispatcher.detach(SOCKET)
    expect(await dispatcher.call(SESSION_HOST_RPC.observe, {}, SOCKET, true)).toMatchObject({
      refusal: { code: 'renegotiate' }
    })
  })

  it('refuses a malformed declaration and a client that declared nothing it understands', async () => {
    const { dispatcher } = await relay()
    expect(
      await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, {
        capabilities: 'all',
        client: CLIENT_HOST
      })
    ).toMatchObject({ refusal: { code: 'invalid-request' } })
    await dispatcher.call(SESSION_HOST_RELAY_DECLARE_METHOD, {
      capabilities: [],
      client: CLIENT_HOST
    })
    expect(await dispatcher.call(SESSION_HOST_RPC.observe, {})).toMatchObject({
      refusal: { code: 'unsupported-capability' }
    })
  })
})
