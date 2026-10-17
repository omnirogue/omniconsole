import { describe, expect, it } from 'vitest'
import {
  localRunFleetNodeIds,
  localRunNodePlacement,
  normalizeLocalRunGraph
} from './local-run-graph'
import {
  LOCAL_RUN_TEMPLATE_IDS,
  LOCAL_RUN_TEMPLATE_MAX_COUNT,
  isLocalRunTemplateId,
  localRunTemplateGraph
} from './local-run-templates'
import { localRunNodeLevels, localRunParallelNodeIds } from './local-run-node-state'

const input = {
  workspacePath: '/Users/me/Webinar',
  actor: { agent: 'codex' as const },
  objective: 'Cut a 45 second opener from the raw footage.'
}

describe('local run seed templates', () => {
  it('every template is a graph the runner would accept, on a plain folder', () => {
    for (const id of LOCAL_RUN_TEMPLATE_IDS) {
      const graph = localRunTemplateGraph(id, input)
      expect(normalizeLocalRunGraph(graph), id).not.toBeNull()
      expect(graph.workspacePath).toBe('/Users/me/Webinar')
      expect(graph.nodes.every((node) => node.objective === input.objective)).toBe(true)
      expect(graph.nodes.every((node) => localRunNodePlacement(node) === 'local')).toBe(true)
      expect(localRunFleetNodeIds(graph)).toEqual([])
    }
  })

  it('research → plan → produce → review → verify is one chain of five steps', () => {
    const graph = localRunTemplateGraph('research-plan-produce-review-verify', input)
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'research',
      'plan',
      'produce',
      'review',
      'verify'
    ])
    expect(graph.nodes.map((node) => node.presetId)).toEqual([
      'research',
      'plan',
      'implement',
      'review',
      'verify'
    ])
    expect(graph.nodes.map((node) => node.deps)).toEqual([
      [],
      ['research'],
      ['plan'],
      ['produce'],
      ['review']
    ])
    // A chain has no siblings, so nothing needs its own isolated workspace.
    expect([...localRunParallelNodeIds(graph)]).toEqual([])
  })

  it('fan-out branches share a depth and all feed the synthesize node', () => {
    const graph = localRunTemplateGraph('fan-out-synthesize', { ...input, count: 3 })
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'branch-1',
      'branch-2',
      'branch-3',
      'synthesize'
    ])
    expect(graph.nodes.at(-1)?.deps).toEqual(['branch-1', 'branch-2', 'branch-3'])
    expect(graph.maxConcurrent).toBe(3)
    const levels = localRunNodeLevels(graph)
    expect([levels.get('branch-1'), levels.get('branch-2'), levels.get('branch-3')]).toEqual([
      0, 0, 0
    ])
    expect(levels.get('synthesize')).toBe(1)
    expect([...localRunParallelNodeIds(graph)].sort()).toEqual(['branch-1', 'branch-2', 'branch-3'])
  })

  it('improve × N chains N improve steps', () => {
    const graph = localRunTemplateGraph('improve-steps', { ...input, count: 4 })
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'improve-1',
      'improve-2',
      'improve-3',
      'improve-4'
    ])
    expect(graph.nodes.every((node) => node.presetId === 'improve')).toBe(true)
    expect(graph.nodes.at(-1)?.deps).toEqual(['improve-3'])
  })

  it('clamps a count nobody should be able to type into a runnable shape', () => {
    expect(localRunTemplateGraph('fan-out-synthesize', { ...input, count: 0 }).nodes).toHaveLength(
      3
    )
    expect(localRunTemplateGraph('improve-steps', { ...input, count: 99 }).nodes).toHaveLength(
      LOCAL_RUN_TEMPLATE_MAX_COUNT
    )
    expect(localRunTemplateGraph('fan-out-synthesize', { ...input, count: 99 }).maxConcurrent).toBe(
      LOCAL_RUN_TEMPLATE_MAX_COUNT
    )
  })

  it('only knows its own template ids', () => {
    expect(isLocalRunTemplateId('fan-out-synthesize')).toBe(true)
    expect(isLocalRunTemplateId('deploy-to-production')).toBe(false)
  })
})

describe('fleet placement on a saved graph', () => {
  it('round-trips an explicit fleet node and names it for a refusal', () => {
    const graph = normalizeLocalRunGraph({
      workspacePath: '/Users/me/Webinar',
      nodes: [
        { id: 'a', actor: { agent: 'codex' }, presetId: 'implement', objective: 'do a', deps: [] },
        {
          id: 'b',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'do b',
          placement: 'fleet',
          deps: ['a']
        }
      ]
    })
    expect(graph?.nodes[0]?.placement).toBeUndefined()
    expect(localRunNodePlacement(graph!.nodes[0])).toBe('local')
    expect(graph?.nodes[1]?.placement).toBe('fleet')
    expect(localRunFleetNodeIds(graph!)).toEqual(['b'])
  })

  it('ignores a placement nobody defined', () => {
    const graph = normalizeLocalRunGraph({
      workspacePath: '/w',
      nodes: [
        {
          id: 'a',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'do a',
          placement: 'moon',
          deps: []
        }
      ]
    })
    expect(graph?.nodes[0]?.placement).toBeUndefined()
    expect(localRunFleetNodeIds(graph!)).toEqual([])
  })
})
