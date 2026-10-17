import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({ opened: true })),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
const activation = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn(() => true) }))
const focus = vi.hoisted(() => ({ activateTabAndFocusPane: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => rpc)
vi.mock('./worktree-activation', () => activation)
vi.mock('./activate-tab-and-focus-pane', () => focus)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { useAppStore } from '@/store'
import { mirroredWorkflowBucketKey } from '@/store/slices/mirrored-workflow-records'
import { SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { SESSION_WORKFLOW_OPEN_RPC } from '../../../shared/session-workflow-records'
import { activateSidebarSession } from './activate-sidebar-session'
import { buildSidebarSessions } from './sidebar-sessions'

const ENV = 'studio'
const WT = 'repo::/work'

function mirroredRow() {
  return buildSidebarSessions(useAppStore.getState()).find((row) => row.mirroredWorkflow)!
}

describe('activating a mirrored workflow row (step 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      tabsByWorktree: {},
      runtimeStatusByEnvironmentId: new Map([[ENV, { status: { graphStatus: 'ready' } }]]) as never,
      mirroredWorkflowRecordsByOwner: {
        [mirroredWorkflowBucketKey(ENV, WT)]: {
          environmentId: ENV,
          worktreeId: WT,
          records: [
            { tabId: 'flow-tab', preset: 'council', title: 'Q', status: 'running', runId: 'run-1' }
          ]
        }
      }
    })
  })

  it('routes to its controller, which opens it there, and creates nothing here', async () => {
    const tabsBefore = useAppStore.getState().tabsByWorktree

    await expect(activateSidebarSession(mirroredRow())).resolves.toEqual({ handled: 'opened' })

    expect(rpc.runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      ENV,
      SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY,
      expect.any(Number)
    )
    expect(rpc.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(rpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENV },
      SESSION_WORKFLOW_OPEN_RPC,
      { worktree: WT, tabId: 'flow-tab' },
      expect.anything()
    )
    expect(activation.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(focus.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree).toBe(tabsBefore)
  })

  it('reports failure, still creating nothing, when the controller refuses or cannot be asked', async () => {
    rpc.callRuntimeRpc.mockRejectedValueOnce(new Error('session_workflow_not_found'))
    await expect(activateSidebarSession(mirroredRow())).resolves.toBe(false)

    rpc.runtimeEnvironmentSupportsCapability.mockResolvedValueOnce(false)
    await expect(activateSidebarSession(mirroredRow())).resolves.toBe(false)
    expect(rpc.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(activation.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree).toEqual({})
  })
})
