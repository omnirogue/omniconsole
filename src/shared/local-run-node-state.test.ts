import { describe, expect, it } from 'vitest'
import {
  deriveLocalRunNodeState,
  isLocalRunEditingPreset,
  localRunNodeLevels,
  localRunNodesInLevelOrder,
  localRunParallelNodeIds
} from './local-run-node-state'
import { normalizeLocalRunGraph, type LocalRunGraph } from './local-run-graph'

function node(id: string, deps: string[] = [], presetId = 'implement') {
  return { id, actor: { agent: 'codex' }, presetId, objective: `do ${id}`, deps }
}

const fanOut = normalizeLocalRunGraph({
  workspacePath: '/work/brief',
  nodes: [
    node('research', [], 'research'),
    node('plan', ['research'], 'plan'),
    node('impl-a', ['plan']),
    node('impl-b', ['plan']),
    node('impl-c', ['plan']),
    node('synth', ['impl-a', 'impl-b', 'impl-c'], 'synthesize'),
    node('verify', ['synth'], 'verify')
  ]
}) as LocalRunGraph

type Rows = Parameters<typeof deriveLocalRunNodeState>[0]

/** Stored rows for one node, defaulting to "nothing has happened to it yet". */
function rows(overrides: Partial<Rows> = {}): Rows {
  return {
    taskStatus: null,
    dispatchStatus: null,
    pendingGate: false,
    openQuestion: false,
    presetId: 'implement',
    ...overrides
  }
}

describe('deriveLocalRunNodeState', () => {
  it('reads each state off the stored rows', () => {
    const cases: [Rows, string][] = [
      [rows({ taskStatus: 'pending' }), 'queued'],
      [rows({ taskStatus: 'ready' }), 'queued'],
      [rows({ taskStatus: 'dispatched' }), 'running'],
      [rows({ taskStatus: 'dispatched', presetId: 'review' }), 'reviewing'],
      [rows({ taskStatus: 'dispatched', presetId: 'verify' }), 'reviewing'],
      [rows({ taskStatus: 'blocked' }), 'waiting'],
      [rows({ taskStatus: 'blocked', pendingGate: true }), 'needs-input'],
      [rows({ taskStatus: 'completed' }), 'completed'],
      [rows({ taskStatus: 'failed' }), 'failed'],
      [rows(), 'queued']
    ]
    for (const [input, expected] of cases) {
      expect(deriveLocalRunNodeState(input)).toBe(expected)
    }
  })

  it('is RUNNING while the dispatch runs, whatever the Task row still says', () => {
    // The local runner starts the worker itself, so the Task row it took off
    // `taskList {ready}` is not moved to `dispatched` by anyone. Reading it alone
    // reported a node with a live worker as QUEUED for its whole turn.
    expect(
      deriveLocalRunNodeState(rows({ taskStatus: 'ready', dispatchStatus: 'dispatched' }))
    ).toBe('running')
    expect(
      deriveLocalRunNodeState(rows({ taskStatus: 'pending', dispatchStatus: 'pending' }))
    ).toBe('running')
    expect(
      deriveLocalRunNodeState(
        rows({ taskStatus: 'ready', dispatchStatus: 'dispatched', presetId: 'verify' })
      )
    ).toBe('reviewing')
  })

  it('lets a terminal Task row outrank a dispatch row that has not settled yet', () => {
    expect(
      deriveLocalRunNodeState(rows({ taskStatus: 'completed', dispatchStatus: 'dispatched' }))
    ).toBe('completed')
    expect(
      deriveLocalRunNodeState(rows({ taskStatus: 'failed', dispatchStatus: 'dispatched' }))
    ).toBe('failed')
  })

  it('goes back to QUEUED once the dispatch has settled and the Task can run again', () => {
    expect(
      deriveLocalRunNodeState(rows({ taskStatus: 'ready', dispatchStatus: 'completed' }))
    ).toBe('queued')
  })

  it('surfaces an unanswered worker question as NEEDS INPUT, not as RUNNING', () => {
    expect(
      deriveLocalRunNodeState(
        rows({ taskStatus: 'ready', dispatchStatus: 'dispatched', openQuestion: true })
      )
    ).toBe('needs-input')
  })
})

describe('graph levels', () => {
  it('computes topological depth', () => {
    const levels = localRunNodeLevels(fanOut)
    expect(levels.get('research')).toBe(0)
    expect(levels.get('plan')).toBe(1)
    expect(levels.get('impl-a')).toBe(2)
    expect(levels.get('synth')).toBe(3)
    expect(levels.get('verify')).toBe(4)
  })

  it('names only the nodes that can run at the same time', () => {
    expect([...localRunParallelNodeIds(fanOut)].sort()).toEqual(['impl-a', 'impl-b', 'impl-c'])
  })

  it('orders nodes so dependencies come first', () => {
    expect(localRunNodesInLevelOrder(fanOut).map((entry) => entry.id)).toEqual([
      'research',
      'plan',
      'impl-a',
      'impl-b',
      'impl-c',
      'synth',
      'verify'
    ])
  })

  it('separates editing presets from read-only ones', () => {
    expect(isLocalRunEditingPreset('implement')).toBe(true)
    expect(isLocalRunEditingPreset('improve')).toBe(true)
    expect(isLocalRunEditingPreset('synthesize')).toBe(true)
    expect(isLocalRunEditingPreset('research')).toBe(false)
    expect(isLocalRunEditingPreset('review')).toBe(false)
  })
})
