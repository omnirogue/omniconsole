import { describe, expect, it } from 'vitest'
import { compileWorkflowDescription } from './workflow-graph-compile'
import { workflowSetFind } from './workflow-graph-find'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate } from './workflow-graph-templates'
import type { WorkflowRoute } from './workflow-graph'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']
const MINE = { query: 'queue library language:go', max: 12 }

const find = (change: Parameters<typeof workflowSetFind>[1] = {}) =>
  workflowSetFind(workflowTemplate('find', ROUTES), change, ROUTES)

const answer = (extra: Record<string, unknown>) =>
  JSON.stringify({
    title: 'Find the best',
    task: '',
    steps: find().steps,
    find: { count: 20, top: 5, ...extra },
    assumptions: []
  })

describe('the person’s GitHub search on the spec', () => {
  it('is set and removed only by the person', () => {
    expect(find({ harvest: MINE }).find?.harvest).toEqual(MINE)
    const kept = workflowSetFind(find({ harvest: MINE }), { count: 40 }, ROUTES)
    expect(kept.find?.harvest).toEqual(MINE)
    expect(workflowSetFind(kept, { harvest: null }, ROUTES).find?.harvest).toBeUndefined()
  })

  it('is dropped when the person switches to complete versions, which nobody searches for', () => {
    const versions = workflowSetFind(find({ harvest: MINE }), { versions: true }, ROUTES)
    expect(versions.find?.harvest).toBeUndefined()
  })

  it('survives a round trip, with the query cut and the count clamped to what is allowed', () => {
    const long = { query: 'x'.repeat(400), max: 4000 }
    const normalized = normalizeWorkflowSpec(find({ harvest: long }), ROUTES)
    expect(normalized.find?.harvest).toEqual({ query: 'x'.repeat(256), max: 100 })
    expect(normalizeWorkflowSpec(find({ harvest: MINE }), ROUTES).find?.harvest).toEqual(MINE)
    expect(normalizeWorkflowSpec(find(), ROUTES).find?.harvest).toBeUndefined()
  })
})

describe('the spec compiler and a GitHub search', () => {
  it('never adds one, however much the description sounds like a search', async () => {
    const compiled = await compileWorkflowDescription({
      description: 'Search GitHub for Go job queues and pick the best one',
      available: ROUTES,
      ask: async () => answer({ harvest: { query: 'anything at all', max: 100 } })
    })
    expect('spec' in compiled && compiled.spec.find?.harvest).toBeUndefined()
  })

  it('keeps the person’s own search, and never one a model rewrote', async () => {
    const current = find({ harvest: MINE })
    for (const extra of [{}, { harvest: { query: 'whatever sells', max: 100 } }]) {
      const changed = await compileWorkflowDescription({
        description: 'Bring back twenty options',
        current,
        available: ROUTES,
        ask: async () => answer(extra)
      })
      expect('spec' in changed && changed.spec.find?.harvest).toEqual(MINE)
    }
  })
})
