import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { ORCHESTRATION_WORKFLOW_RESULT_METHODS } from './orchestration-workflow-result-submit'
import { requireWorkflowResultWorker } from './orchestration-workflow-result-authority'
import {
  acceptWorkingAgentResult,
  getWorkingAgentCallForDispatch
} from '../../workflow-script/workflow-working-agent-calls'
import { captureWorkingAgentDispatchArtifacts } from '../../workflow-script/workflow-working-agent-dispatch-artifacts'

vi.mock('./orchestration-workflow-result-authority', () => ({
  requireWorkflowResultWorker: vi.fn()
}))
vi.mock('../../workflow-script/workflow-working-agent-calls', () => ({
  acceptWorkingAgentResult: vi.fn(),
  getWorkingAgentCallForDispatch: vi.fn()
}))
vi.mock('../../workflow-script/workflow-working-agent-dispatch-artifacts', () => ({
  captureWorkingAgentDispatchArtifacts: vi.fn()
}))

const emptyArtifacts = { files: [], diff: '', omissions: [] }
const artifactDigest = createHash('sha256').update(JSON.stringify(emptyArtifacts)).digest('hex')

async function submit(result: unknown) {
  const method = ORCHESTRATION_WORKFLOW_RESULT_METHODS[0]!
  const params = method.params!.parse({ dispatch: 'dispatch_1', from: 'worker_1', result })
  return await method.handler(params, {
    runtime: {} as RpcContext['runtime'],
    orchestrationCapability: 'dcap_worker',
    orchestrationCompatibilityEvidence: {
      terminalHandle: 'worker_1',
      paneKey: 'tab:leaf',
      launchToken: 'launch-secret'
    }
  })
}

describe('workflow result-submit artifact preaccept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWorkflowResultWorker).mockReturnValue({} as never)
    vi.mocked(getWorkingAgentCallForDispatch).mockReturnValue({
      call_id: 'answers/seat-a'
    } as never)
    vi.mocked(captureWorkingAgentDispatchArtifacts).mockResolvedValue({
      ...emptyArtifacts,
      digest: artifactDigest
    })
    vi.mocked(acceptWorkingAgentResult).mockReturnValue({ accepted: true })
  })

  it('passes the captured child artifact digest into atomic result acceptance', async () => {
    await expect(submit({ markdown: 'A bounded answer' })).resolves.toEqual({ accepted: true })
    expect(requireWorkflowResultWorker).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        dispatchId: 'dispatch_1',
        from: 'worker_1',
        callerEvidence: {
          terminalHandle: 'worker_1',
          paneKey: 'tab:leaf',
          launchToken: 'launch-secret'
        }
      })
    )
    expect(captureWorkingAgentDispatchArtifacts).toHaveBeenCalledWith({}, 'dispatch_1')
    expect(acceptWorkingAgentResult).toHaveBeenCalledWith(
      {},
      'dispatch_1',
      { markdown: 'A bounded answer' },
      artifactDigest
    )
  })

  it('keeps the same Dispatch open when an answer discloses its generator', async () => {
    await expect(
      submit({ markdown: 'I am Claude and I generated this response.' })
    ).resolves.toMatchObject({
      accepted: false,
      problems: expect.stringContaining('identifying metadata')
    })
    expect(acceptWorkingAgentResult).not.toHaveBeenCalled()
  })

  it('does not accept a result if child artifact capture fails', async () => {
    vi.mocked(captureWorkingAgentDispatchArtifacts).mockRejectedValueOnce(
      new Error('Writable Dispatch child worktree identity is missing or changed')
    )
    await expect(submit({ markdown: 'Answer' })).resolves.toMatchObject({
      accepted: false,
      problems: expect.stringContaining('worktree identity')
    })
    expect(acceptWorkingAgentResult).not.toHaveBeenCalled()
  })
})
