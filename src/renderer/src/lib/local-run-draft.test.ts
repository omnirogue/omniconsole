import { describe, expect, it, vi } from 'vitest'
import { normalizeLocalRunGraph } from '../../../shared/local-run-graph'
import {
  addLocalRunDraftNode,
  connectLocalRunDraftNodes,
  disconnectLocalRunDraftNodes,
  localRunDraftFromSaved,
  localRunDraftFromTemplate,
  localRunDraftGraph,
  localRunDraftSaveParams,
  localRunDraftView,
  newLocalRunDraft,
  removeLocalRunDraftNode
} from './local-run-draft'
import {
  isSequentialLocalRunDraft,
  localRunAdmissionDraft,
  localRunAdmissionRefusal,
  localRunStartRefusal
} from './local-run-admission'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

const folder = { path: '/Users/me/Webinar', selector: 'id:folder:1', kind: 'folder' as const }
const repo = {
  path: '/Users/me/omni-ide',
  selector: 'id:repo::/Users/me/omni-ide',
  kind: 'git' as const
}

function chain() {
  let draft = newLocalRunDraft(folder, { title: 'Opener' })
  draft = {
    ...draft,
    nodes: [
      {
        ...draft.nodes[0],
        presetId: 'research',
        objective: 'Read the brief',
        agent: 'claude',
        model: 'opus',
        effort: 'high',
        accountChoiceId: 'profile:work'
      }
    ]
  }
  draft = addLocalRunDraftNode(draft, { presetId: 'implement', objective: 'Cut the opener' })
  return connectLocalRunDraftNodes(draft, 'step-1', 'step-2', 'cycle').draft
}

describe('the draft → localRun.create payload', () => {
  it('carries the actor, the preset, the gate, the placement and the dependencies', () => {
    let draft = chain()
    draft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === 'step-2'
          ? { ...node, gate: true, gateQuestion: 'Publish this cut?', placement: 'fleet' as const }
          : node
      )
    }
    const graph = localRunDraftGraph(draft)
    expect(graph.workspacePath).toBe('/Users/me/Webinar')
    expect(graph.nodes[0]).toEqual({
      id: 'step-1',
      actor: { agent: 'claude', model: 'opus', effort: 'high', accountChoiceId: 'profile:work' },
      presetId: 'research',
      objective: 'Read the brief',
      deps: []
    })
    expect(graph.nodes[1]).toEqual({
      id: 'step-2',
      actor: { agent: 'codex' },
      presetId: 'implement',
      objective: 'Cut the opener',
      gate: { question: 'Publish this cut?' },
      placement: 'fleet',
      deps: ['step-1']
    })
    // The runner's own normalizer must accept exactly what the canvas would send.
    expect(normalizeLocalRunGraph(graph)).not.toBeNull()
  })

  it('drops an unticked gate and an empty actor field rather than sending them empty', () => {
    const graph = localRunDraftGraph(chain())
    expect(graph.nodes[1]).not.toHaveProperty('gate')
    expect(graph.nodes[1]).not.toHaveProperty('placement')
    expect(graph.nodes[1].actor).toEqual({ agent: 'codex' })
  })

  it('saves beside automations through Phase 2’s own draft domain', () => {
    const params = localRunDraftSaveParams(chain())
    expect(params.title).toBe('Opener')
    expect(params.graph.nodes.map((node) => node.id)).toEqual(['step-1', 'step-2'])
    const restored = localRunDraftFromSaved(
      { id: params.id, title: params.title, graph: params.graph, createdAt: 1, updatedAt: 2 },
      { selector: folder.selector, kind: 'folder' }
    )
    expect(localRunDraftGraph(restored)).toEqual(params.graph)
    expect(restored.nodes[0].accountChoiceId).toBe('profile:work')
  })
})

describe('authoring on the canvas', () => {
  it('adds steps with fresh ids and forgets the edges of a removed step', () => {
    const draft = addLocalRunDraftNode(chain())
    expect(draft.nodes.map((node) => node.id)).toEqual(['step-1', 'step-2', 'step-3'])
    const pruned = removeLocalRunDraftNode(draft, 'step-1')
    expect(pruned.nodes.map((node) => node.id)).toEqual(['step-2', 'step-3'])
    expect(pruned.nodes[0].deps).toEqual([])
  })

  it('refuses an edge that would make the graph a cycle, and says so', () => {
    const draft = chain()
    const cycle = connectLocalRunDraftNodes(draft, 'step-2', 'step-1', 'That would be a loop.')
    expect(cycle.error).toBe('That would be a loop.')
    expect(cycle.draft).toBe(draft)
    const self = connectLocalRunDraftNodes(draft, 'step-1', 'step-1', 'That would be a loop.')
    expect(self.error).toBe('That would be a loop.')
  })

  it('connects and disconnects without duplicating an edge', () => {
    const draft = connectLocalRunDraftNodes(chain(), 'step-1', 'step-2', 'cycle').draft
    expect(draft.nodes[1].deps).toEqual(['step-1'])
    expect(disconnectLocalRunDraftNodes(draft, 'step-1', 'step-2').nodes[1].deps).toEqual([])
  })

  it('seeds a fan-out template a person can then edit', () => {
    const draft = localRunDraftFromTemplate('fan-out-synthesize', newLocalRunDraft(folder), {
      objective: 'Three cuts of the opener',
      agent: 'codex',
      count: 3
    })
    expect(draft.nodes.map((node) => node.id)).toEqual([
      'branch-1',
      'branch-2',
      'branch-3',
      'synthesize'
    ])
    expect(draft.nodes.at(-1)?.deps).toEqual(['branch-1', 'branch-2', 'branch-3'])
    expect(draft.maxConcurrent).toBe(3)
    expect(localRunStartRefusal(draft)).toBeNull()
  })

  it('draws a draft as the same graph the canvas draws for a run', () => {
    const view = localRunDraftView(chain())
    expect(view.nodes.map((node) => node.state)).toEqual(['queued', 'queued'])
    expect(view.nodes.map((node) => node.after)).toEqual([[], ['step-1']])
    expect(view.nodes.every((node) => node.workspacePath === '/Users/me/Webinar')).toBe(true)
    expect(view.loops).toEqual([])
  })
})

describe('refusing to run a draft', () => {
  it('names the steps with no objective', () => {
    const draft = addLocalRunDraftNode(chain())
    expect(localRunStartRefusal(draft)?.code).toBe('no-objective')
    expect(localRunStartRefusal(draft)?.message).toContain('step-3')
  })

  it('names a step that asks first but was never given the question', () => {
    const draft = chain()
    const gated = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === 'step-2' ? { ...node, gate: true, gateQuestion: '  ' } : node
      )
    }
    expect(localRunStartRefusal(gated)?.code).toBe('no-gate-question')
  })

  it('refuses to start fleet work locally and names the steps', () => {
    const draft = chain()
    const fleet = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === 'step-2' ? { ...node, placement: 'fleet' as const } : node
      )
    }
    const refusal = localRunStartRefusal(fleet)
    expect(refusal?.code).toBe('fleet-placed')
    expect(refusal?.message).toContain('step-2')
  })

  it('lets a complete local chain run', () => {
    expect(localRunStartRefusal(chain())).toBeNull()
  })
})

describe('refusing to admit a draft', () => {
  it('refuses a folder workspace and names the folder', () => {
    const refusal = localRunAdmissionRefusal(chain())
    expect(refusal?.code).toBe('folder-workspace')
    expect(refusal?.message).toContain('/Users/me/Webinar')
    expect(refusal?.message).toContain('Run this graph locally')
  })

  it('admits a sequential graph on a git workspace', () => {
    const draft = { ...chain(), ...repoWorkspace() }
    expect(localRunAdmissionRefusal(draft)).toBeNull()
    expect(isSequentialLocalRunDraft(draft)).toBe(true)
  })

  it('keeps the sequential-only restriction for parallel columns', () => {
    const parallel = {
      ...localRunDraftFromTemplate('fan-out-synthesize', newLocalRunDraft(repo), {
        objective: 'Three cuts',
        agent: 'codex',
        count: 3
      }),
      ...repoWorkspace()
    }
    expect(isSequentialLocalRunDraft(parallel)).toBe(false)
    expect(localRunAdmissionRefusal(parallel)?.code).toBe('not-sequential')
  })

  it('hands Lane 3 a composer draft with the stages, actors and placements', () => {
    const draft = { ...chain(), ...repoWorkspace() }
    const fleet = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === 'step-2' ? { ...node, placement: 'fleet' as const } : node
      )
    }
    const composer = localRunAdmissionDraft(fleet)
    expect(composer.stages.map((stage) => stage.key)).toEqual(['step-1', 'step-2'])
    expect(composer.stages.map((stage) => stage.after)).toEqual([[], ['step-1']])
    expect(composer.stages[0]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      prompt: 'Read the brief',
      placement: 'local'
    })
    expect(composer.stages[1].placement).toBe('fleet')
    // The card, organization and policies stay empty: the console composer owns them.
    expect(composer.taskId).toBe('')
    expect(composer.company).toBe('')
    expect(composer.admission.adoptStage).toBe('step-1')
  })
})

function repoWorkspace() {
  return {
    workspacePath: repo.path,
    workspaceSelector: repo.selector,
    workspaceKind: 'git' as const
  }
}
