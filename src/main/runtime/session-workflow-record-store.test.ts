import { describe, expect, it, vi } from 'vitest'
import {
  readSessionWorkflowRecordPublication,
  readSessionWorkflowRecordSet,
  type RuntimeSessionWorkflowRecord
} from '../../shared/session-workflow-records'
import { SessionWorkflowRecordStore } from './session-workflow-record-store'

function record(
  tabId: string,
  overrides: Partial<RuntimeSessionWorkflowRecord> = {}
): RuntimeSessionWorkflowRecord {
  return {
    tabId,
    preset: 'council',
    title: `Council ${tabId}`,
    status: 'running',
    runId: `run-${tabId}`,
    ...overrides
  }
}

function publish(
  store: SessionWorkflowRecordStore,
  recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>,
  complete = true
): boolean {
  return store.publish({ rendererGeneration: 'r', recordsByWorktree, complete })
}

describe('SessionWorkflowRecordStore (step 9)', () => {
  it('is incomplete, with no records, until the window publishes its whole set', () => {
    const store = new SessionWorkflowRecordStore()
    expect(store.snapshot()).toEqual({
      generation: store.generation,
      revision: 0,
      complete: false,
      recordsByWorktree: {}
    })
  })

  it('moves its revision on every change to the set and on nothing else', () => {
    const store = new SessionWorkflowRecordStore()
    const listener = vi.fn()
    store.onChange(listener)

    expect(publish(store, { a: [record('1')] })).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 1, complete: true })
    expect(publish(store, { a: [record('1', { status: 'done' })] })).toBe(true)
    expect(store.snapshot().revision).toBe(2)
    // An identical republication (a renderer reload) is no change at all.
    expect(publish(store, { a: [record('1', { status: 'done' })] })).toBe(false)
    expect(store.snapshot().revision).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  // Why: a workspace leaving and returning with the same records must be a newer set each time.
  it('orders a removal and a re-addition with unchanged records as newer sets', () => {
    const store = new SessionWorkflowRecordStore()
    publish(store, { a: [record('1')], b: [record('2')] })
    const before = store.snapshot()
    publish(store, { b: [record('2')] })
    const removed = store.snapshot()
    publish(store, { a: [record('1')], b: [record('2')] })
    const readded = store.snapshot()
    expect(removed.revision).toBeGreaterThan(before.revision)
    expect(removed.recordsByWorktree).toEqual({ b: [record('2')] })
    expect(readded.revision).toBeGreaterThan(removed.revision)
    expect(readded.recordsByWorktree).toEqual(before.recordsByWorktree)
  })

  it('stops vouching for omissions once its window is gone, keeping the last records', () => {
    const store = new SessionWorkflowRecordStore()
    publish(store, { a: [record('1')] })
    const listener = vi.fn()
    store.onChange(listener)

    store.markPublisherGone()
    expect(store.snapshot()).toMatchObject({
      revision: 2,
      complete: false,
      recordsByWorktree: { a: [record('1')] }
    })
    expect(store.getRendererGeneration()).toBeNull()
    store.markPublisherGone()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('never reads a set with a dropped record as complete', () => {
    const malformed = readSessionWorkflowRecordPublication({
      rendererGeneration: 'r',
      recordsByWorktree: { a: [record('1'), { tabId: 'broken' }] }
    })
    expect(malformed).toMatchObject({ complete: false, recordsByWorktree: { a: [record('1')] } })
    const overCap = readSessionWorkflowRecordSet({
      generation: 'g',
      revision: 1,
      complete: true,
      recordsByWorktree: {
        a: Array.from({ length: 501 }, (_, index) => record(String(index)))
      }
    })
    expect(overCap?.complete).toBe(false)
    expect(overCap?.recordsByWorktree.a).toHaveLength(500)
    expect(
      readSessionWorkflowRecordSet({
        generation: 'g',
        revision: 1,
        complete: true,
        recordsByWorktree: { a: [record('1')] }
      })?.complete
    ).toBe(true)
  })

  it('gives each runtime incarnation its own generation', () => {
    expect(new SessionWorkflowRecordStore().generation).not.toBe(
      new SessionWorkflowRecordStore().generation
    )
  })
})
