import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCAL_RUN_RPC } from '../../../../shared/local-run-types'
import { normalizeLocalRunGraph } from '../../../../shared/local-run-graph'
import { localRunTemplateGraph } from '../../../../shared/local-run-templates'
import { localRunParallelNodeIds } from '../../../../shared/local-run-node-state'
import { ALL_RPC_METHODS } from './index'
import { LOCAL_RUN_METHODS } from './local-runs'

const ACCEPTANCE_GRAPH = pathToFileURL(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'acceptance',
    'local-run-folder-graph.mjs'
  )
).href

describe('local run RPC surface', () => {
  it('registers every named method on the dispatcher manifest', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const name of Object.values(LOCAL_RUN_RPC)) {
      expect(registered.has(name), `${name} is not registered`).toBe(true)
    }
    expect(registered.has('localRun.reply')).toBe(true)
    for (const method of LOCAL_RUN_METHODS) {
      expect(registered.has(method.name), `${method.name} is not registered`).toBe(true)
    }
  })

  it('accepts the acceptance graph shape and refuses a broken one', () => {
    const node = (id: string, deps: string[]) => ({
      id,
      actor: { agent: 'claude', model: 'opus', effort: 'high' },
      presetId: 'implement',
      objective: `produce ${id}`,
      deps
    })
    const create = LOCAL_RUN_METHODS.find((method) => method.name === LOCAL_RUN_RPC.create)!
    expect(() =>
      create.params!.parse({
        graph: { workspacePath: '/work/brief', maxConcurrent: 3, nodes: [node('a', [])] }
      })
    ).not.toThrow()
    expect(() => create.params!.parse({ graph: { nodes: [node('a', [])] } })).toThrow()
    expect(() => create.params!.parse({ graph: { workspacePath: '/w', nodes: [] } })).toThrow()
  })

  it('admits the canvas acceptance shape: the fan-out template, saved and created', () => {
    // Why here: scripts/acceptance/canvas-local-run.mjs sends this exact template graph
    // through saveDraft and create. A seed the dispatcher would refuse is not evidence.
    const graph = localRunTemplateGraph('fan-out-synthesize', {
      workspacePath: '/work/brief',
      actor: { agent: 'codex' },
      objective: 'Cut a 45 second opener from the clips in ./clips.',
      count: 3
    })
    const create = LOCAL_RUN_METHODS.find((method) => method.name === LOCAL_RUN_RPC.create)!
    expect(() => create.params!.parse({ graph })).not.toThrow()
    const saveDraft = LOCAL_RUN_METHODS.find((method) => method.name === LOCAL_RUN_RPC.saveDraft)!
    expect(() =>
      saveDraft.params!.parse({ id: 'acceptance-fan-out', title: 'Acceptance fan-out', graph })
    ).not.toThrow()
    expect(localRunParallelNodeIds(normalizeLocalRunGraph(graph)!)).toEqual(
      new Set(['branch-1', 'branch-2', 'branch-3'])
    )
  })

  it("admits the acceptance script's own graph", async () => {
    // Why the script's own module: an acceptance graph the runner would refuse is
    // not acceptance evidence, and nothing else exercises that file.
    const { localRunAcceptanceGraph } = (await import(ACCEPTANCE_GRAPH)) as {
      localRunAcceptanceGraph: (workspacePath: string) => unknown
    }
    const graph = normalizeLocalRunGraph(localRunAcceptanceGraph('/work/brief'))
    expect(graph).not.toBeNull()
    expect(graph!.nodes.map((entry) => entry.id)).toEqual([
      'research',
      'plan',
      'cut-a',
      'cut-b',
      'cut-c',
      'assemble',
      'check'
    ])
    expect(localRunParallelNodeIds(graph!)).toEqual(new Set(['cut-a', 'cut-b', 'cut-c']))
    // A different actor per node is the point of the acceptance.
    const actors = graph!.nodes.map((entry) =>
      [entry.actor.agent, entry.actor.model, entry.actor.effort].filter(Boolean).join('/')
    )
    expect(new Set(actors).size).toBe(actors.length - 1)
    expect(graph!.maxConcurrent).toBe(3)
    const create = LOCAL_RUN_METHODS.find((method) => method.name === LOCAL_RUN_RPC.create)!
    expect(() =>
      create.params!.parse({ graph: localRunAcceptanceGraph('/work/brief') })
    ).not.toThrow()
  })
})
