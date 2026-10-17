import { describe, expect, it, vi } from 'vitest'
import { retryLocalWorkflowPlacement } from './local-workflow-retry-placement'
import type { LocalWorkflowHostOptions } from './local-workflow-host-options'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'

function fixture(named = false) {
  const old = {
    mode: 'dispatched-seats',
    ...(named ? { choice: 'named' } : {}),
    host: { machine: 'old' }
  }
  const next: WorkflowPlacement = {
    mode: 'dispatched-seats',
    runsOn: 'fleet',
    host: { name: 'new', machine: 'new', cores: 8, loadPerCore: 0.1, readAt: 1, ssh: 'new' }
  }
  const store = {
    inspect: () => ({ snapshot: { host: { placement: old } } }),
    retryFailed: vi.fn()
  }
  const options = {
    place: vi.fn(async () => next),
    dispatch: vi.fn(async () => next),
    discardDispatch: vi.fn(async () => {})
  }
  return {
    store,
    options,
    next,
    run: () =>
      retryLocalWorkflowPlacement(
        store as unknown as WorkflowCheckpointStore,
        options as unknown as LocalWorkflowHostOptions,
        'run',
        2
      )
  }
}

describe('Retry placement', () => {
  it('takes fresh placement excluding the failed host and commits only after readiness', async () => {
    const f = fixture()
    await f.run()
    expect(f.options.place).toHaveBeenCalledWith('fleet', undefined, ['old'])
    expect(f.options.dispatch).toHaveBeenCalledOnce()
    expect(f.store.retryFailed).toHaveBeenCalledWith('run', 2, f.next)
  })
  it('preserves a named host', async () => {
    const f = fixture(true)
    await f.run()
    expect(f.options.place).not.toHaveBeenCalled()
    expect(f.store.retryFailed).toHaveBeenCalledWith('run', 2, undefined)
  })
  it('discards a newly readied copy if the ledger refuses Retry', async () => {
    const f = fixture()
    f.store.retryFailed.mockImplementation(() => {
      throw new Error('no allowance')
    })
    await expect(f.run()).rejects.toThrow('no allowance')
    expect(f.options.discardDispatch).toHaveBeenCalledWith(f.next)
  })
})
