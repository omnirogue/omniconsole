import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PTY = 'pty_federated_stop'
const HANDLE = 'term_federated_stop'
const WORKSPACE = 'folder:federated-stop'
const HOME_PEER = 'home_peer'
const WORKER_PEER = 'worker_peer'
const databases: OrchestrationDb[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function method(name: string) {
  return ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)!
}

function createFederatedWorker() {
  const homeDb = new OrchestrationDb(':memory:')
  const workerDb = new OrchestrationDb(':memory:')
  databases.push(homeDb, workerDb)
  const home = new OrcaRuntimeService(null)
  const worker = new OrcaRuntimeService(null)
  home.setOrchestrationDb(homeDb)
  worker.setOrchestrationDb(workerDb)
  worker.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  worker.registerPty(PTY, WORKSPACE, null, { tabId: TAB, leafId: LEAF, incarnationId: 'worker_1' })
  worker.registerPreAllocatedHandleForPty(PTY, HANDLE)
  worker.attachWindow(1)
  worker.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB, worktreeId: WORKSPACE, title: 'Worker', activeLeafId: LEAF, layout: null }
    ],
    leaves: [{ tabId: TAB, worktreeId: WORKSPACE, leafId: LEAF, paneRuntimeId: 1, ptyId: PTY }]
  })
  const run = homeDb.createRun({
    objective: 'Federated stop interleaving',
    coordinatorHandle: 'term_home',
    coordinatorPaneKey: '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
  })
  const task = homeDb.createTask({ spec: 'Stop the exact peer worker', runId: run.id })
  const { dispatch } = homeDb.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 3,
    taskId: task.id,
    startOptions: {},
    runtimeEpoch: home.getRuntimeId(),
    federation: {
      environmentId: 'environment_worker',
      environmentName: 'worker',
      peerFingerprint: WORKER_PEER,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION
    }
  })
  workerDb.createRemoteDispatchAttachment({
    dispatchId: dispatch.id,
    taskId: task.id,
    homePeerFingerprint: HOME_PEER,
    protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
    runtimeEpoch: worker.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: HOME_PEER,
      requestId: 'request_attach',
      method: 'orchestration.federationStart',
      payloadHash: 'attach_hash'
    }
  })
  workerDb.prepareRemoteAttachmentAuthority({
    dispatchId: dispatch.id,
    paneKey: worker.getTerminalPaneKey(HANDLE)!,
    processIncarnation: worker.getTerminalProcessIncarnation(HANDLE)!,
    worktreeId: WORKSPACE,
    terminalHandle: HANDLE,
    setupState: 'not_applicable',
    effects: [{ kind: 'terminal', action: 'created', id: HANDLE }]
  })
  workerDb.markRemoteAttachmentReady(dispatch.id)
  homeDb.reconcileFederatedWorkerStart({
    dispatchId: dispatch.id,
    state: 'ready',
    stage: 'input_accepted',
    terminalHandle: HANDLE,
    worktreeId: WORKSPACE
  })
  vi.spyOn(home, 'resolveOrchestrationWorkerServer').mockReturnValue({
    environmentId: 'environment_worker',
    name: 'worker',
    peerFingerprint: WORKER_PEER
  })
  vi.spyOn(home, 'callOrchestrationWorkerServer').mockImplementation(
    async (_server, name, args) => {
      if (name === 'status.get') {
        return worker.getStatus()
      }
      expect(name).toBe('orchestration.federationStop')
      const stop = method(name)
      return stop.handler(stop.params!.parse(args), {
        runtime: worker,
        authenticatedCallerFingerprint: HOME_PEER
      })
    }
  )
  return { homeDb, workerDb, home, worker, task, dispatch }
}

it.each([
  { label: 'available', failPublication: false },
  { label: 'unavailable', failPublication: true }
])(
  'settles both hosts when a peer exit precedes close and home observations are $label',
  async ({ failPublication }) => {
    const { homeDb, workerDb, home, worker, task, dispatch } = createFederatedWorker()
    const exit = worker.waitForTerminal(HANDLE, { condition: 'exit', timeoutMs: 1000 })
    const close = vi.spyOn(worker, 'closeTerminal').mockImplementation(async (handle) => {
      expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('stopping')
      expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('stopping')
      worker.markPtyStopRequested(PTY)
      worker.onPtyExit(PTY, 0, 'worker_1', {
        providerExitObserved: true,
        cause: { kind: 'operator_close' }
      })
      return { handle, tabId: TAB, ptyKilled: true }
    })
    if (failPublication) {
      vi.spyOn(home, 'recordOrchestrationExecutionObservation').mockImplementation(() => {
        throw new Error('Home observation publication unavailable')
      })
    }
    const stop = method('orchestration.workerStop')

    await expect(
      stop.handler(stop.params!.parse({ dispatch: dispatch.id }), {
        runtime: home,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request_stop',
          method: 'orchestration.workerStop',
          payloadHash: 'stop_hash'
        }
      })
    ).resolves.toMatchObject({
      state: 'stopped',
      processAction: failPublication ? 'none' : 'closed_agent_terminal'
    })
    expect(close).toHaveBeenCalledExactlyOnceWith(HANDLE)
    expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('stopped')
    expect(homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped',
      capability_revoked_at: expect.any(String)
    })
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'stopped',
      stage: 'process_stopped',
      capability_hash: null
    })
    await expect(exit).resolves.toMatchObject({
      satisfied: true,
      exitCause: { kind: 'operator_close' }
    })
  }
)
