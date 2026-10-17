import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { screenedDiscover } from './workflow-discover-screen.test-fixture'
import { workflowTemplate } from './workflow-graph-templates'
import { validateWorkflowSpec } from './workflow-graph-validate'
import {
  withSetupPages,
  withWebScreenRubric,
  workflowWebPrefill,
  workflowWebScreenRubric,
  workflowWebSetup
} from './workflow-web-setup'

const ROUTES = ['claude', 'codex', 'grok'] as const
const PAGE = 'https://example.com/pricing'
const problems = (spec: WorkflowSpec) =>
  validateWorkflowSpec(normalizeWorkflowSpec(spec, ROUTES), { available: ROUTES }).problems.map(
    (problem) => problem.message
  )
const pagesOf = (spec: WorkflowSpec, id: string) =>
  spec.steps.find((step) => step.id === id)?.web?.urls

describe('which step setup gives the pages', () => {
  it('reads on Discover’s Find, Investigate’s investigators and the Research panel’s research', () => {
    expect(workflowWebSetup(workflowTemplate('discover', ROUTES))).toEqual({
      kind: 'reads',
      stepId: 'find'
    })
    expect(workflowWebSetup(screenedDiscover(ROUTES))).toEqual({
      kind: 'reads',
      stepId: 'find',
      screenStepId: 'verify'
    })
    expect(workflowWebSetup(workflowTemplate('investigate', ROUTES))).toEqual({
      kind: 'reads',
      stepId: 'investigate'
    })
    expect(workflowWebSetup(workflowTemplate('research-panel', ROUTES))).toEqual({
      kind: 'reads',
      stepId: 'research'
    })
  })

  it('says Decide cannot read pages, and offers nothing elsewhere', () => {
    expect(workflowWebSetup(workflowTemplate('decide', ROUTES))).toEqual({ kind: 'decide' })
    expect(workflowWebSetup(workflowTemplate('council', ROUTES))).toBeUndefined()
    expect(workflowWebSetup(workflowTemplate('find', ROUTES))).toBeUndefined()
  })

  it('lets Investigate and the Research panel read pages as they are: neither has a model-written rubric', () => {
    for (const [key, id] of [
      ['investigate', 'investigate'],
      ['research-panel', 'research']
    ] as const) {
      const spec = withSetupPages(workflowTemplate(key, ROUTES), id, [PAGE])
      expect(pagesOf(spec, id)).toEqual([PAGE])
      expect(problems(spec), key).toEqual([])
    }
  })
})

describe('Discover’s rubric when it reads pages', () => {
  it('has none to choose by default: Discover has no screen', () => {
    const spec = withSetupPages(workflowTemplate('discover', ROUTES), 'find', [PAGE])
    expect(workflowWebScreenRubric(spec)).toBeUndefined()
    expect(problems(spec)).toEqual([])
  })

  const discover = () => withSetupPages(screenedDiscover(ROUTES), 'find', [PAGE])

  it('refuses the brief’s model-written rubric until the person chooses one', () => {
    expect(workflowWebScreenRubric(discover())).toBe('model')
    expect(problems(discover()).join(' ')).toMatch(/scores only by a rubric you write/)
  })

  it('runs with the generic rubric or one the person writes', () => {
    const generic = withWebScreenRubric(discover(), 'generic')
    expect(workflowWebScreenRubric(generic)).toBe('generic')
    expect(problems(generic)).toEqual([])
    const written = withWebScreenRubric(discover(), { text: '- Does it quote the page?' })
    expect(workflowWebScreenRubric(written)).toEqual({ text: '- Does it quote the page?' })
    expect(problems(written)).toEqual([])
  })

  it('never takes an empty rubric for the generic one', () => {
    const cleared = withWebScreenRubric(discover(), { text: '  ' })
    expect(workflowWebScreenRubric(cleared)).toBe('model')
  })

  it('goes back to the brief’s rubric once no page is left, keeping a rubric the person wrote', () => {
    const generic = withWebScreenRubric(discover(), 'generic')
    expect(workflowWebScreenRubric(withSetupPages(generic, 'find', []))).toBe('model')
    const written = withWebScreenRubric(discover(), { text: '- Mine' })
    expect(workflowWebScreenRubric(withSetupPages(written, 'find', []))).toEqual({ text: '- Mine' })
  })
})

describe('the request’s addresses', () => {
  it('are added to the reader’s pages, except the ones the person removed', () => {
    const spec = workflowTemplate('investigate', ROUTES)
    const prompt = `Is ${PAGE} right? See also https://example.org/terms and http://10.0.0.1/.`
    const next = workflowWebPrefill(spec, prompt, new Set(['https://example.org/terms']))!
    expect(pagesOf(next, 'investigate')).toEqual([PAGE])
    expect(workflowWebPrefill(next, prompt, new Set(['https://example.org/terms']))).toBeUndefined()
  })

  it('are never added where pages are refused, or to Decide', () => {
    const spec = workflowTemplate('investigate', ROUTES)
    const routed: WorkflowSpec = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'skeptic' ? { ...step, agents: [{ route: 'openrouter' }] } : step
      )
    }
    expect(workflowWebPrefill(routed, PAGE, new Set())).toBeUndefined()
    expect(workflowWebPrefill(workflowTemplate('decide', ROUTES), PAGE, new Set())).toBeUndefined()
  })
})
