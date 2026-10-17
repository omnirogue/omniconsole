import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { GraphWebChangedError } from './graph/graph-web-sources'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowExecutionService } from './workflow-execution-service'
import { runWorkflowPreset } from './workflow-preset-runner'
import { WorkflowScriptSlots } from './workflow-script-slots'

// The program itself is not under test: only how an ordinary Resume ends when it throws.
vi.mock('./workflow-preset-runner', () => ({ runWorkflowPreset: vi.fn() }))

const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.mocked(runWorkflowPreset).mockReset()
})

function pausedRun() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    progress: vi.fn(),
    launch: () => async () => {
      throw new Error('no agent runs here')
    }
  })
  const id = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: {
      version: 1,
      councilProgramRevision: 4,
      seats: [],
      synthesizerId: 'seat',
      task: { prompt: 'Read the pages', evidence: '' }
    },
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 3,
    budgetLimit: 9
  })
  expect(store.requestControl(id, 1, 'pause')).toBe('paused')
  return { store, service, id }
}

describe('Resume when kept web pages were lost', () => {
  it('holds the run for manual recovery instead of failing it', async () => {
    const run = pausedRun()
    vi.mocked(runWorkflowPreset).mockRejectedValue(
      new GraphWebChangedError('research/web', 'A web call started but its record is missing')
    )
    run.service.resume(run.id, 1)
    expect(await run.service.wait(run.id)).toEqual({
      state: 'recovery_required',
      error: 'A web call started but its record is missing (research/web)'
    })
    expect(run.store.inspect(run.id, 1).state).not.toBe('failed')
  })

  it('hands the program the checkpoint\u2019s record of web calls that began', async () => {
    const run = pausedRun()
    vi.mocked(runWorkflowPreset).mockResolvedValue({
      final: { stepId: 'x', markdown: 'x' }
    } as never)
    run.service.resume(run.id, 1)
    await run.service.wait(run.id)
    const starts = vi.mocked(runWorkflowPreset).mock.calls[0]![4]!.webStarts!
    expect(starts.has('research/web')).toBe(false)
    run.store.attempts.webStarts(run.id, 1).begin('research/web', 'digest')
    expect(starts.has('research/web')).toBe(true)
  })

  it('still fails a run on any other error', async () => {
    const run = pausedRun()
    vi.mocked(runWorkflowPreset).mockRejectedValue(new Error('The workflow failed.'))
    run.service.resume(run.id, 1)
    expect(await run.service.wait(run.id)).toMatchObject({ state: 'failed' })
  })
})
