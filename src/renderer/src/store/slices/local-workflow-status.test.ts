import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { LocalWorkflowChangedEvent } from '../../../../shared/local-workflow-rpc'
import { createLocalWorkflowStatusSlice } from './local-workflow-status'

function makeStore() {
  return create<
    Pick<
      AppState,
      | 'localWorkflowStatusByTabId'
      | 'setLocalWorkflowStatus'
      | 'localWorkflowHydrationByTabId'
      | 'setLocalWorkflowHydration'
    >
  >()((...args) => ({
    ...createLocalWorkflowStatusSlice(
      ...(args as Parameters<typeof createLocalWorkflowStatusSlice>)
    )
  }))
}

const running: LocalWorkflowChangedEvent = {
  conversationId: 'tab-1',
  executionId: 'execution-1',
  preset: 'council',
  state: 'running',
  running: 2,
  completed: 1,
  total: 7,
  phase: 'First opinions'
}

describe('local workflow status slice', () => {
  it('keeps the latest status per conversation', () => {
    const store = makeStore()
    store.getState().setLocalWorkflowStatus(running)
    store
      .getState()
      .setLocalWorkflowStatus({ ...running, conversationId: 'tab-2', preset: 'discover' })
    store.getState().setLocalWorkflowStatus({ ...running, state: 'completed', running: 0 })
    expect(store.getState().localWorkflowStatusByTabId).toEqual({
      'tab-1': { ...running, state: 'completed', running: 0 },
      'tab-2': { ...running, conversationId: 'tab-2', preset: 'discover' }
    })
  })

  it('does not republish the map for an unchanged status', () => {
    const store = makeStore()
    store.getState().setLocalWorkflowStatus(running)
    const before = store.getState().localWorkflowStatusByTabId
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    store.getState().setLocalWorkflowStatus({ ...running })
    expect(store.getState().localWorkflowStatusByTabId).toBe(before)
    expect(notified).toBe(0)
    store.getState().setLocalWorkflowStatus({ ...running, phase: 'Peer rankings' })
    expect(notified).toBe(1)
  })

  // Why (C6): a not-found or failed read is kept until a real status for that run supersedes it.
  it('keeps a read outcome until a status for the same run arrives', () => {
    const store = makeStore()
    store.getState().setLocalWorkflowHydration('tab-1', {
      runId: 'execution-1',
      outcome: 'failed',
      attempts: 3
    })
    store.getState().setLocalWorkflowStatus({ ...running, executionId: 'execution-0' })
    expect(store.getState().localWorkflowHydrationByTabId['tab-1']?.outcome).toBe('failed')
    store.getState().setLocalWorkflowStatus(running)
    expect(store.getState().localWorkflowHydrationByTabId['tab-1']).toBeUndefined()
    expect(store.getState().localWorkflowStatusByTabId['tab-1']).toEqual(running)
  })
})
