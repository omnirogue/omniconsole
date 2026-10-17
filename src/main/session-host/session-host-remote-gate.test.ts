import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readClientSessionHostDeclaration,
  readRuntimeSessionHostAdvertisement,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES
} from '../../shared/session-host-capabilities'
import { SESSION_HOST_RPC } from '../../shared/session-host-protocol'
import { SESSION_HOST_REQUEST_FIXTURES } from '../../shared/session-host-request-fixtures'
import {
  legacyClientCapabilities,
  phase4ClientCapabilities
} from '../../shared/session-host-wire-fixtures'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { SESSION_HOST_METHODS } from '../runtime/rpc/methods/session-host'
import type { RpcContext } from '../runtime/rpc/core'
import { UNSUPPORTED_SESSION_HOST_EXECUTOR } from './session-host-executor'
import { handleSessionHostRemoteCall, type SessionHostRemotePeer } from './session-host-remote-gate'
import {
  handleRuntimeSessionHostCall,
  runtimeSessionHostProcess,
  runtimeSessionHostStatus,
  setRuntimeSessionHostProcessForTests
} from './session-host-runtime'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
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

const peer = (declared: readonly string[] | undefined): SessionHostRemotePeer => ({
  transport: 'paired-runtime',
  peer: 'paired:mac-a',
  declared: readClientSessionHostDeclaration(declared ? [...declared] : undefined),
  connection: null
})
const FULL = peer(phase4ClientCapabilities())

async function readyHost() {
  const executor = new FakeSessionHostExecutor()
  const process = testHostProcess({ root: host.root, incarnation: 'runtime-1', executor })
  const service = await process.service()
  const { conversationId } = await adoptTestConversation(service)
  return { executor, process, conversationId }
}

describe('the runtime serves every sessionHost method', () => {
  it('registers exactly the contract route set, in the flat manifest', () => {
    const names = SESSION_HOST_METHODS.map((method) => method.name).sort()
    expect(names).toEqual(Object.values(SESSION_HOST_RPC).sort())
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const name of names) {
      expect(registered.has(name)).toBe(true)
    }
  })

  it('advertises nothing until an executor can carry actions out, then capabilities with identity', async () => {
    const process = testHostProcess({ root: host.root, incarnation: 'runtime-1' })
    setRuntimeSessionHostProcessForTests(process)
    await process.service()
    expect(runtimeSessionHostStatus('runtime-1')).toBeNull()
    process.installExecutor(new FakeSessionHostExecutor())
    const status = runtimeSessionHostStatus('runtime-1')
    expect(status?.capabilities).toEqual(SESSION_HOST_CAPABILITIES)
    // What a client reads from `runtime.status`: advertised, bound to this runtime's id.
    const read = readRuntimeSessionHostAdvertisement({
      runtimeId: 'runtime-1',
      ...status!,
      capabilities: status!.capabilities
    })
    expect(read).toMatchObject({ status: 'advertised', identity: { incarnation: 'runtime-1' } })
    // Another runtime id (a second runtime in this process) never borrows this identity.
    expect(runtimeSessionHostStatus('runtime-2')).toBeNull()
  })

  it('does not advertise organization or waits without the methods behind them', async () => {
    const executor = new FakeSessionHostExecutor()
    const partial = Object.assign(Object.create(Object.getPrototypeOf(executor)), executor, {
      tidy: undefined,
      waitStatus: undefined
    })
    const process = testHostProcess({
      root: host.root,
      incarnation: 'runtime-1',
      executor: partial
    })
    expect(process.capabilities()).toEqual([
      SESSION_CONTROL_OWNER_CAPABILITY,
      'session-transfer.remote-source.v1',
      'session-relocation.claude.v1',
      'session-relocation.codex.v1',
      'session-relocation.bundle.v1',
      'session-control.delivery.v1',
      'session-control.host-stats.v1'
    ])
    // Moving bundles is never offered without a provider's relocation beside it.
    const bundleOnly = Object.assign(Object.create(Object.getPrototypeOf(executor)), executor, {
      capabilities: () => [SESSION_CONTROL_OWNER_CAPABILITY, 'session-relocation.bundle.v1']
    })
    expect(
      testHostProcess({
        root: host.root,
        incarnation: 'runtime-2',
        executor: bundleOnly
      }).capabilities()
    ).toEqual([SESSION_CONTROL_OWNER_CAPABILITY])
  })

  it('refuses everything with the stub executor, and never opens a registry to do it', async () => {
    const process = testHostProcess({
      root: host.root,
      incarnation: 'runtime-1',
      executor: UNSUPPORTED_SESSION_HOST_EXECUTOR
    })
    const result = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.execute,
      SESSION_HOST_REQUEST_FIXTURES.continue,
      FULL
    )
    expect(result).toMatchObject({ status: 'refused', refusal: { code: 'unsupported-capability' } })
    expect(process.current()).toBeNull()
  })
})

describe('unsupported clients cannot bypass the guards', () => {
  it('a client that declared nothing, or an older build, is refused every method', async () => {
    const { process, conversationId } = await readyHost()
    for (const declared of [undefined, [], legacyClientCapabilities()]) {
      for (const method of Object.values(SESSION_HOST_RPC)) {
        const result = await handleSessionHostRemoteCall(
          process,
          method,
          { conversationId },
          peer(declared)
        )
        expect(result).toMatchObject({
          status: 'refused',
          refusal: { code: 'unsupported-capability' }
        })
      }
    }
  })

  it('a client that agreed owner control only cannot slip an organization action through execute', async () => {
    const { executor, process } = await readyHost()
    const result = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.execute,
      SESSION_HOST_REQUEST_FIXTURES.rename,
      peer([SESSION_CONTROL_OWNER_CAPABILITY])
    )
    expect(result).toMatchObject({
      status: 'refused',
      refusal: { code: 'unsupported-capability', capability: 'session-organization.host.v1' }
    })
    expect(executor.dispatched).toEqual([])
  })

  it('a payload cannot claim authority, and a request without origin is refused as unproven', async () => {
    const { executor, process, conversationId } = await readyHost()
    const request = continueRequest(1, conversationId)
    const forged = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.execute,
      {
        ...request,
        payload: { ...request.payload, actor: { kind: 'person' } }
      },
      FULL
    )
    expect(forged).toMatchObject({ status: 'refused', refusal: { code: 'invalid-request' } })
    const steward = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.execute,
      {
        ...request,
        origin: { computer: 'Studio', requester: { kind: 'steward' } }
      },
      FULL
    )
    expect(steward).toMatchObject({ status: 'refused', refusal: { code: 'invalid-request' } })
    const { origin: _origin, ...bare } = request
    const unproven = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.execute,
      bare,
      FULL
    )
    expect(unproven).toMatchObject({ status: 'refused', refusal: { code: 'provenance-required' } })
    expect(executor.dispatched).toEqual([])
  })

  it('this computer’s own socket and a dispatched worker are refused; a paired device is served', async () => {
    const { executor, process, conversationId } = await readyHost()
    setRuntimeSessionHostProcessForTests(process)
    const runtime = { getRuntimeId: () => 'runtime-1' } as RpcContext['runtime']
    const request = continueRequest(1, conversationId)
    const local = await handleRuntimeSessionHostCall(SESSION_HOST_RPC.execute, request, {
      runtime,
      clientCapabilities: phase4ClientCapabilities()
    })
    expect(local).toMatchObject({ status: 'refused', refusal: { code: 'provenance-required' } })
    const worker = await handleRuntimeSessionHostCall(SESSION_HOST_RPC.execute, request, {
      runtime,
      pairedDeviceId: 'mac-a',
      clientCapabilities: phase4ClientCapabilities(),
      orchestrationCapability: 'dispatch-token'
    })
    expect(worker).toMatchObject({ status: 'refused', refusal: { code: 'provenance-required' } })
    expect(executor.dispatched).toEqual([])
    const paired = await handleRuntimeSessionHostCall(SESSION_HOST_RPC.execute, request, {
      runtime,
      pairedDeviceId: 'mac-a',
      clientCapabilities: phase4ClientCapabilities()
    })
    expect(paired).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
    expect(executor.dispatched).toHaveLength(1)
    expect(runtimeSessionHostProcess('runtime-1')).toBe(process)
  })
})
