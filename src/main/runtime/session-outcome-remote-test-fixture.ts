import { SESSION_CHAIN_METHODS } from './rpc/methods/session-chains'
import { join } from 'node:path'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeHostCapabilities } from '../../shared/session-outcome-routing'

export async function remoteOutcomeFixture(
  mode?: 'old' | 'missing',
  restoreFrom?: string,
  wsPort = 0
) {
  const host = outcomeRuntimeFixture((_spec, workspace) => {
    host.write('result.txt', `executed on ${workspace}`)
    return { body: 'Host execution completed' }
  }, restoreFrom)
  const server = new OrcaRuntimeRpcServer({
    runtime: host.runtime,
    userDataPath: join(host.workspace, '.omni'),
    enableWebSocket: true,
    wsPort,
    preferPinnedWsPort: wsPort !== 0,
    ...(mode
      ? {
          methods: SESSION_CHAIN_METHODS.filter(
            (method) => mode !== 'missing' || method.name !== 'sessionChain.outcomeCapabilities'
          ).map((method) =>
            method.name === 'sessionChain.outcomeCapabilities'
              ? { ...method, handler: () => ({ version: 1, durableContinuation: true }) }
              : method
          )
        }
      : {})
  })
  await server.start()
  const offer = server.createPairingOffer({
    name: 'Outcome SSH-tunnel integration',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('Pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('Invalid pairing')
  }
  const connections: RemoteRuntimeRequestConnection[] = []
  const connect = (savedPairing: PairingOffer = pairing) => {
    const connection = new RemoteRuntimeRequestConnection(savedPairing)
    connections.push(connection)
    return connection
  }
  const connection = connect()
  const reply = await connection.request<SessionOutcomeHostCapabilities>(
    'sessionChain.outcomeCapabilities',
    undefined,
    5000
  )
  const capabilities: SessionOutcomeHostCapabilities = reply.ok
    ? reply.result
    : { version: 0, durableContinuation: false, reason: reply.error.message }
  const chain: SessionChain = {
    id: 'remote_outcome',
    workspacePath: host.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'runtime:tunnel',
    placement: 'runtime:tunnel',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const outcome: SessionOutcomeDefinition = {
    id: 'result',
    title: 'Host file',
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: join(host.workspace, 'result.txt') }],
    actions: [
      {
        id: 'write',
        instruction: 'Produce the host-owned result',
        authority: 'existing-user-authority',
        agent: 'codex',
        conditionIds: ['file']
      }
    ]
  }
  return {
    host,
    server,
    connection,
    pairing,
    connect,
    chain,
    outcome,
    capabilities,
    async dispose() {
      connections.forEach((entry) => entry.close())
      await server.stop()
      await host.dispose()
    }
  }
}
