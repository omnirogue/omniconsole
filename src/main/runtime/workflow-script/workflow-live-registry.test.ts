import { describe, expect, it, vi } from 'vitest'
import {
  WORKFLOW_LIVE_FINISHED_LIMIT,
  WORKFLOW_LIVE_LOG_LIMIT,
  WORKFLOW_LIVE_TAIL_LIMIT,
  WorkflowLiveRegistry
} from './workflow-live-registry'

describe('workflow live registry', () => {
  it('keeps the latest phase and a bounded log ring per execution', () => {
    const registry = new WorkflowLiveRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.progress('run-1', { phase: 'First opinions' })
    for (let index = 0; index < WORKFLOW_LIVE_LOG_LIMIT + 5; index++) {
      registry.progress('run-1', { message: `line ${index}` })
    }
    const live = registry.read('run-1')!
    expect(live.phase).toBe('First opinions')
    expect(live.log).toHaveLength(WORKFLOW_LIVE_LOG_LIMIT)
    expect(live.log[0]).toBe('line 5')
    expect(live.log.at(-1)).toBe(`line ${WORKFLOW_LIVE_LOG_LIMIT + 4}`)
    expect(listener).toHaveBeenCalledWith('run-1', 'state')
    expect(registry.read('run-2')).toBeUndefined()
  })

  it('moves a call from waiting to starting to running and drops it when durable state answers', () => {
    const registry = new WorkflowLiveRegistry()
    const observer = registry.observer('run-1')
    registry.queued('run-1', 'answer/seat-1', 'seat-1')
    expect(registry.read('run-1')!.calls.get('answer/seat-1')).toMatchObject({
      seatId: 'seat-1',
      phase: 'waiting',
      reason: 'slot'
    })
    registry.acquired('run-1', 'answer/seat-1')
    observer.starting('answer/seat-1', 'attempt-1')
    observer.spawned('answer/seat-1', 'attempt-1', 1_000)
    observer.update('answer/seat-1', 'attempt-1', {
      activity: 'Reading src/app.ts',
      text: 'The cache ',
      tokens: { input: 10, output: 2 }
    })
    observer.update('answer/seat-1', 'attempt-1', { text: 'is safe.' })
    expect(registry.read('run-1')!.calls.get('answer/seat-1')).toMatchObject({
      phase: 'running',
      attemptId: 'attempt-1',
      startedAt: 1_000,
      activity: 'Reading src/app.ts',
      tail: 'The cache is safe.',
      outputChars: 18,
      tokens: { input: 10, output: 2 }
    })
    observer.exited('answer/seat-1', 'attempt-1', 2_000)
    expect(registry.read('run-1')!.calls.get('answer/seat-1')?.phase).toBe('finishing')
    registry.settled('run-1', 'answer/seat-1')
    expect(registry.read('run-1')!.calls.has('answer/seat-1')).toBe(false)
    // The seat stays known after settlement so completed calls keep their label.
    expect(registry.read('run-1')!.seats.get('answer/seat-1')).toBe('seat-1')
  })

  it('starts a new attempt from an empty tail and ignores signals from the previous attempt', () => {
    const registry = new WorkflowLiveRegistry()
    const observer = registry.observer('run-1')
    registry.queued('run-1', 'chair/final', 'seat-1')
    observer.starting('chair/final', 'attempt-1')
    observer.update('chair/final', 'attempt-1', {
      text: 'first try',
      tokens: { input: 1, output: 1 }
    })
    observer.starting('chair/final', 'attempt-2')
    observer.update('chair/final', 'attempt-1', { text: 'late output from the first try' })
    observer.spawned('chair/final', 'attempt-1', 5)
    const call = registry.read('run-1')!.calls.get('chair/final')!
    expect(call).toMatchObject({ attemptId: 'attempt-2', phase: 'starting', tail: '' })
    expect(call.tokens).toBeUndefined()
    expect(call.startedAt).toBeUndefined()
  })

  it('keeps only a rolling tail and reports streamed text as an output change', () => {
    const registry = new WorkflowLiveRegistry()
    const changes: string[] = []
    registry.subscribe((_id, change) => changes.push(change))
    const observer = registry.observer('run-1')
    registry.queued('run-1', 'answer/seat-2', 'seat-2')
    observer.starting('answer/seat-2', 'attempt-1')
    changes.length = 0
    observer.update('answer/seat-2', 'attempt-1', { text: 'a'.repeat(WORKFLOW_LIVE_TAIL_LIMIT) })
    observer.update('answer/seat-2', 'attempt-1', { text: 'tail-end' })
    const call = registry.read('run-1')!.calls.get('answer/seat-2')!
    expect(call.tail).toHaveLength(WORKFLOW_LIVE_TAIL_LIMIT)
    expect(call.tail.endsWith('tail-end')).toBe(true)
    expect(call.outputChars).toBe(WORKFLOW_LIVE_TAIL_LIMIT + 'tail-end'.length)
    expect(changes).toEqual(['output', 'output'])
  })

  it('clears stale calls when the execution finishes but keeps its phase and log', () => {
    const registry = new WorkflowLiveRegistry()
    registry.progress('run-1', { phase: 'Chairman', message: 'Two answers arrived' })
    registry.queued('run-1', 'chair/final', 'seat-1')
    registry.finish('run-1')
    const live = registry.read('run-1')!
    expect(live.calls.size).toBe(0)
    expect(live.phase).toBe('Chairman')
    expect(live.log).toEqual(['Two answers arrived'])
  })

  it('starts a resumed or retried run from an empty log but keeps its seats', () => {
    const registry = new WorkflowLiveRegistry()
    registry.progress('run-1', { phase: 'Chairman', message: 'Asking 3 members' })
    registry.queued('run-1', 'chair/final', 'seat-1')
    registry.finish('run-1')
    registry.restart('run-1')
    const live = registry.read('run-1')!
    expect(live.phase).toBeUndefined()
    expect(live.log).toEqual([])
    expect(live.calls.size).toBe(0)
    expect(live.seats.get('chair/final')).toBe('seat-1')
    registry.progress('run-1', { message: 'Asking 3 members' })
    expect(registry.read('run-1')!.log).toEqual(['Asking 3 members'])
  })

  it('forgets the oldest finished runs but never a running or restarted one', () => {
    const registry = new WorkflowLiveRegistry()
    registry.progress('running', { phase: 'First opinions' })
    registry.progress('restarted', { phase: 'Chairman' })
    registry.finish('restarted')
    registry.restart('restarted')
    for (let index = 0; index <= WORKFLOW_LIVE_FINISHED_LIMIT; index++) {
      registry.progress(`run-${index}`, { phase: 'Rank' })
      registry.finish(`run-${index}`)
    }
    expect(registry.read('run-0')).toBeUndefined()
    expect(registry.read('run-1')?.phase).toBe('Rank')
    expect(registry.read(`run-${WORKFLOW_LIVE_FINISHED_LIMIT}`)?.phase).toBe('Rank')
    expect(registry.read('running')?.phase).toBe('First opinions')
    expect(registry.read('restarted')).toBeDefined()
  })

  it('isolates a failing listener from the run and from other listeners', () => {
    const registry = new WorkflowLiveRegistry()
    const healthy = vi.fn()
    registry.subscribe(() => {
      throw new Error('renderer went away')
    })
    const unsubscribe = registry.subscribe(healthy)
    expect(() => registry.touch('run-1')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith('run-1', 'state')
    unsubscribe()
    registry.touch('run-1')
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})
