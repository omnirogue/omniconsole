import { describe, expect, it } from 'vitest'
import { normalizeLocalRunDrafts, normalizeLocalRunGraph } from './local-run-graph'

function node(id: string, deps: string[] = []) {
  return { id, actor: { agent: 'codex' }, presetId: 'implement', objective: `do ${id}`, deps }
}

describe('normalizeLocalRunGraph', () => {
  it('keeps a valid graph with actors, gates and deliver nodes', () => {
    const graph = normalizeLocalRunGraph({
      workspacePath: '/work/brief',
      maxConcurrent: 3,
      nodes: [
        {
          id: 'research',
          actor: { agent: 'claude', model: 'opus', effort: 'high', accountChoiceId: 'profile:x' },
          presetId: 'research',
          objective: 'find the clips',
          deps: []
        },
        {
          ...node('cut', ['research']),
          gate: { question: 'Approve the cut list?', options: ['yes', 'no'] },
          deliver: { taskId: 'btk_abcd', to: ['sal'], message: 'the cut' }
        }
      ]
    })
    expect(graph?.nodes[0]?.actor).toEqual({
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      accountChoiceId: 'profile:x'
    })
    expect(graph?.nodes[1]?.gate?.options).toEqual(['yes', 'no'])
    expect(graph?.nodes[1]?.deliver?.to).toEqual(['sal'])
    expect(graph?.maxConcurrent).toBe(3)
  })

  it('refuses a cycle', () => {
    expect(
      normalizeLocalRunGraph({
        workspacePath: '/work/brief',
        nodes: [node('a', ['b']), node('b', ['a'])]
      })
    ).toBeNull()
  })

  it('refuses a self dependency and an unknown dependency', () => {
    expect(normalizeLocalRunGraph({ workspacePath: '/w', nodes: [node('a', ['a'])] })).toBeNull()
    expect(
      normalizeLocalRunGraph({ workspacePath: '/w', nodes: [node('a', ['ghost'])] })
    ).toBeNull()
  })

  it('refuses duplicate ids, an empty graph and a missing workspace', () => {
    expect(
      normalizeLocalRunGraph({ workspacePath: '/w', nodes: [node('a'), node('a')] })
    ).toBeNull()
    expect(normalizeLocalRunGraph({ workspacePath: '/w', nodes: [] })).toBeNull()
    expect(normalizeLocalRunGraph({ nodes: [node('a')] })).toBeNull()
  })

  it('drops a node with an unknown agent or preset rather than guessing one', () => {
    expect(
      normalizeLocalRunGraph({
        workspacePath: '/w',
        nodes: [{ ...node('a'), actor: { agent: 'not-an-agent' } }]
      })
    ).toBeNull()
    expect(
      normalizeLocalRunGraph({ workspacePath: '/w', nodes: [{ ...node('a'), presetId: 'deploy' }] })
    ).toBeNull()
  })

  it('clamps maxConcurrent into the supported range', () => {
    expect(
      normalizeLocalRunGraph({ workspacePath: '/w', maxConcurrent: 99, nodes: [node('a')] })
        ?.maxConcurrent
    ).toBe(8)
    expect(
      normalizeLocalRunGraph({ workspacePath: '/w', maxConcurrent: 0, nodes: [node('a')] })
        ?.maxConcurrent
    ).toBe(1)
  })
})

describe('normalizeLocalRunDrafts', () => {
  it('keeps the first draft per id and drops unusable ones', () => {
    const drafts = normalizeLocalRunDrafts([
      {
        id: 'd1',
        title: 'Video',
        graph: { workspacePath: '/w', nodes: [node('a')] },
        createdAt: 1
      },
      { id: 'd1', title: 'Duplicate', graph: { workspacePath: '/w', nodes: [node('a')] } },
      { id: 'd2', graph: { workspacePath: '/w', nodes: [] } },
      { id: 'd3', graph: { workspacePath: '/w', nodes: [node('b')] } }
    ])
    expect(drafts.map((draft) => draft.id)).toEqual(['d1', 'd3'])
    expect(drafts[0]?.title).toBe('Video')
    expect(drafts[1]?.title).toBe('d3')
  })
})
