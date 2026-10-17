import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { requireWorkflowResultWorker } from './orchestration-workflow-result-authority'

function fixture() {
  const evidence = {
    terminalHandle: 'worker_1',
    paneKey: 'tab:leaf',
    launchToken: 'launch-secret'
  }
  const db = {
    getDispatchContextById: vi.fn(() => ({
      id: 'dispatch_1',
      status: 'dispatched',
      assignee_handle: 'worker_1'
    })),
    getFederatedDispatch: vi.fn(() => undefined),
    getWorkerDispatch: vi.fn(() => ({ state: 'ready' })),
    verifyDispatchCapability: vi.fn(() => ({ valid: true as const })),
    isDispatchMessageSender: vi.fn(() => true)
  }
  const runtime = {
    getOrchestrationDb: () => db,
    verifyOrchestrationCompatibilityCaller: vi.fn(() => ({
      terminalHandle: 'worker_1',
      paneKey: 'tab:leaf',
      processIncarnation: 'pty:incarnation'
    })),
    getTerminalPaneKey: vi.fn(() => 'untrusted:pane'),
    getTerminalProcessIncarnation: vi.fn(() => 'untrusted:process')
  } as unknown as OrcaRuntimeService
  return { db, runtime, evidence }
}

describe('workflow result worker authority', () => {
  it('uses the exact Dispatch capability, pane and process before accepting a result', () => {
    const { db, runtime, evidence } = fixture()
    expect(
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'dcap_worker',
        callerEvidence: evidence
      })
    ).toBe(db)
    expect(runtime.verifyOrchestrationCompatibilityCaller).toHaveBeenCalledWith(evidence, {
      currentRuntimeLaunchSufficient: true
    })
    expect(db.verifyDispatchCapability).toHaveBeenCalledWith({
      dispatchId: 'dispatch_1',
      capability: 'dcap_worker',
      paneKey: 'tab:leaf',
      processIncarnation: 'pty:incarnation'
    })
    expect(runtime.getTerminalPaneKey).not.toHaveBeenCalled()
    expect(runtime.getTerminalProcessIncarnation).not.toHaveBeenCalled()
  })

  it('rejects a failed capability check and never reaches result acceptance', () => {
    const { db, runtime, evidence } = fixture()
    db.verifyDispatchCapability.mockReturnValueOnce({
      valid: false,
      reason: 'The Dispatch capability is invalid.'
    } as never)
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'wrong',
        callerEvidence: evidence
      })
    ).toThrow('The Dispatch capability is invalid.')
  })

  it('refuses a remote Dispatch until a Run-home result relay exists', () => {
    const { db, runtime, evidence } = fixture()
    db.getFederatedDispatch.mockReturnValueOnce({ dispatch_id: 'dispatch_1' } as never)
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'dcap_worker',
        callerEvidence: evidence
      })
    ).toThrow('Run-home relay')
    expect(db.verifyDispatchCapability).not.toHaveBeenCalled()
  })

  it('rejects a missing or unverifiable launch claim before touching the Dispatch', () => {
    const { db, runtime, evidence } = fixture()
    vi.mocked(runtime.verifyOrchestrationCompatibilityCaller).mockReturnValue(null)
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'dcap_worker'
      })
    ).toThrow('not the attested worker terminal')
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'dcap_worker',
        callerEvidence: evidence
      })
    ).toThrow('not the attested worker terminal')
    expect(db.getDispatchContextById).not.toHaveBeenCalled()
  })

  it('rejects a spoofed --from even with a valid Dispatch capability', () => {
    const { db, runtime, evidence } = fixture()
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_2',
        capability: 'dcap_worker',
        callerEvidence: evidence
      })
    ).toThrow('not the attested worker terminal')
    expect(db.verifyDispatchCapability).not.toHaveBeenCalled()
  })

  it('requires the attested pane to own the Dispatch', () => {
    const { db, runtime, evidence } = fixture()
    db.isDispatchMessageSender.mockReturnValue(false)
    expect(() =>
      requireWorkflowResultWorker(runtime, {
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        capability: 'dcap_worker',
        callerEvidence: evidence
      })
    ).toThrow('does not own this Dispatch')
  })
})
