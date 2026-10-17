// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { useCoreStore } from './coreStore'
import type { CoreState, Task } from './coreStoreTypes'
import { isOfficeTaskProjection } from './office-task-projection'
import { useUiStore } from './uiStore'

function task(id: string, requiresUserApproval = true): Task {
  return {
    id,
    title: 'Prepare customer response',
    description: 'Waiting for the recorded decision',
    assignedAgentId: 2,
    status: 'on_hold',
    requiresUserApproval,
    draftOutput: 'Existing draft',
    output: 'Recorded output',
    revisions: [{ output: 'Earlier draft', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 2
  }
}

const mutations: [string, (store: CoreState, taskId: string) => void][] = [
  ['approve', (store, id) => store.approveTask(id)],
  ['reject', (store, id) => store.rejectTask(id, 'Retry locally')],
  ['remove', (store, id) => store.removeTask(id)],
  ['complete', (store, id) => store.updateTaskStatus(id, 'done')],
  ['review', (store, id) => store.submitTaskForReview(id, 'Local draft')],
  ['output', (store, id) => store.setTaskOutput(id, 'Local output')]
]

beforeEach(() => {
  useCoreStore.setState(useCoreStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
})

describe.each([
  ['sess:customer-response', true],
  ['sess:customer-response', false],
  ['worktree:customer-response', true],
  ['worktree:customer-response', false]
] as const)('office projection %s with approval=%s', (taskId, requiresUserApproval) => {
  it.each(mutations)(
    'refuses local %s without changing task, history, phase or agent state',
    (_, mutate) => {
      useCoreStore.setState({
        tasks: [task(taskId, requiresUserApproval)],
        phase: 'working',
        agentHistories: { 2: [{ role: 'assistant', content: 'Awaiting hub decision' }] }
      })
      useUiStore.setState({ agentStatuses: { 2: 'on_hold' } })
      const before = useCoreStore.getState()
      const uiBefore = useUiStore.getState()

      mutate(before, taskId)

      expect(useCoreStore.getState()).toBe(before)
      expect(useUiStore.getState()).toBe(uiBefore)
    }
  )
})

describe('ad hoc office tasks', () => {
  it('preserves creation, review, rejection, approval and removal for task_* rows', () => {
    const store = useCoreStore.getState()
    const created = store.addTask({
      title: 'Local draft',
      description: '',
      assignedAgentId: 2,
      status: 'scheduled',
      requiresUserApproval: true
    })
    expect(created.id).toMatch(/^task_/)
    expect(isOfficeTaskProjection(created.id)).toBe(false)
    store.startProject('Ad hoc work')
    store.updateTaskStatus(created.id, 'in_progress')
    expect(useCoreStore.getState().tasks[0].status).toBe('in_progress')

    store.submitTaskForReview(created.id, 'First draft')
    expect(useCoreStore.getState().tasks[0]).toMatchObject({
      status: 'on_hold',
      draftOutput: 'First draft'
    })
    store.rejectTask(created.id, 'Add detail')
    expect(useCoreStore.getState().tasks[0]).toMatchObject({
      status: 'scheduled',
      reviewComments: 'Add detail',
      draftOutput: undefined,
      revisions: [expect.objectContaining({ output: 'First draft', feedback: 'Add detail' })]
    })
    expect(useCoreStore.getState().agentHistories[2]).toEqual([
      { role: 'user', content: 'Rejected. Reason: Add detail' }
    ])

    store.setTaskOutput(created.id, 'Saved output')
    expect(useCoreStore.getState().tasks[0].output).toBe('Saved output')
    store.submitTaskForReview(created.id, 'Revised draft')
    store.approveTask(created.id)
    expect(useCoreStore.getState().tasks[0]).toMatchObject({
      status: 'done',
      output: 'Revised draft',
      draftOutput: undefined
    })
    expect(useCoreStore.getState().tasks[0].revisions).toHaveLength(2)
    expect(useUiStore.getState().agentStatuses[2]).toBe('idle')
    store.updateTaskStatus(created.id, 'in_progress')
    expect(useCoreStore.getState().tasks[0].status).toBe('done')
    store.removeTask(created.id)
    expect(useCoreStore.getState()).toMatchObject({ tasks: [], phase: 'done' })
  })

  it('matches only the reserved projection namespaces', () => {
    expect(isOfficeTaskProjection('sess:abc')).toBe(true)
    expect(isOfficeTaskProjection('worktree:abc')).toBe(true)
    for (const id of ['task_sess:abc', 'task_worktree:abc', 'session:abc', 'abc', '']) {
      expect(isOfficeTaskProjection(id)).toBe(false)
    }
  })
})
