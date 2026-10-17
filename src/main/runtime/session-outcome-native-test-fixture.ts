import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import { createOrchestrationCaller } from './build-review/build-review-rpc-call'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import type { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

/** Real card projection and capability-bound planning report; only terminal and hub I/O are fixtures. */
export async function bindNativeOutcomeSource(f: ReturnType<typeof outcomeRuntimeFixture>) {
  const unused = async (): Promise<never> => {
    throw new Error('No handoff was requested in this fixture')
  }
  installSessionOutcomeHandoffTransport({
    principal: async () => 'co_omni:emp_sal',
    hub: {
      upload: unused,
      send: unused,
      sendCardless: unused,
      uploadThreadFile: unused,
      isRejected: () => false
    }
  })
  const call = createOrchestrationCaller(f.runtime)
  const created = await call<{ run: { id: string }; projectionTaskId: string }>(
    'orchestration.runCreate',
    {
      from: 'term_source_coordinator',
      objective: 'Original full outcome',
      hubTaskId: 'btk_nativeoutcomes'
    }
  )
  const source = f.db.createStartingWorkerDispatch({
    taskId: created.projectionTaskId,
    creator: { kind: 'system' },
    maxDepth: 3,
    startOptions: {}
  }).dispatch
  const capability = f.db.prepareStartingWorkerAuthority({
    dispatchId: source.id,
    handle: 'source',
    paneKey: f.runtime.getTerminalPaneKey('source')!,
    processIncarnation: f.runtime.getTerminalProcessIncarnation('source')!,
    worktreeId: 'folder:outcome',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  f.db.markWorkerDispatchReady(source.id)
  return {
    ...created,
    source,
    settleSource: async () => {
      const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!
      await method.handler(
        method.params!.parse({
          from: 'source',
          type: 'worker_done',
          subject: 'Plan committed',
          body: 'Planning only; business work remains in the committed outcomes.',
          payload: JSON.stringify({
            taskId: created.projectionTaskId,
            dispatchId: source.id,
            outcome: 'succeeded'
          })
        }),
        { runtime: f.runtime, orchestrationCapability: capability }
      )
    }
  }
}
