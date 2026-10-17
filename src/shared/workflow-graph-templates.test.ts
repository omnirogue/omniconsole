import { describe, expect, it } from 'vitest'
import { WORKFLOW_MAX_AGENTS_PER_STEP, type WorkflowRoute } from './workflow-graph'
import { BEST_OF_N_ANGLES, findOptionsStep, workflowSetFind } from './workflow-graph-find'
import { workflowJevConfirmAt, workflowJevRejectAt } from './workflow-graph-review-triage'
import { workflowTemplate } from './workflow-graph-templates'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { localWorkflowFindSpec } from './local-workflow-find-request'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

describe('Best of N as Find complete versions', () => {
  it.each([undefined, 2, 4, 8])('uses the Find versions construction for count %s', (count) => {
    const spec = workflowTemplate('best-of-n', ROUTES, { count })
    expect(spec).toEqual({
      ...workflowSetFind(workflowTemplate('find', ROUTES), { versions: true, count }, ROUTES),
      template: 'best-of-n'
    })
    expect(spec.template).toBe('best-of-n')
    expect(spec.find).toMatchObject({ versions: true, count: count ?? 4 })
    expect(findOptionsStep(spec)?.list).toBeUndefined()
    expect(validateWorkflowSpec(spec, { available: ROUTES }).problems).toEqual([])
    expect(
      findOptionsStep(spec)
        ?.agents.slice(0, 4)
        .map((agent) => agent.angle)
    ).toEqual(BEST_OF_N_ANGLES.slice(0, Math.min(count ?? 4, 4)))
  })

  it.each([[], ['claude'], ['gemini']].map((routes) => ({ routes: routes as WorkflowRoute[] })))(
    'uses the existing route fallbacks for $routes',
    ({ routes }) => {
      const spec = workflowTemplate('best-of-n', routes, { count: 100 })
      expect(spec.find?.count).toBe(WORKFLOW_MAX_AGENTS_PER_STEP)
      expect(findOptionsStep(spec)?.agents).toHaveLength(WORKFLOW_MAX_AGENTS_PER_STEP)
      expect(spec).toEqual({
        ...workflowSetFind(
          workflowTemplate('find', routes),
          { versions: true, count: 100 },
          routes
        ),
        template: 'best-of-n'
      })
    }
  )

  it('resolves local versions requests to the same Find shape as the template key', () => {
    // The CLI/local request path stays a Find run (template 'find'); only the preset tab is
    // labelled 'best-of-n', so the two specs agree on everything but that label.
    const request = { prompt: 'Write a landing page', versions: true, count: 4 }
    const fromRequest = localWorkflowFindSpec(request, ROUTES, [])
    const fromTemplate = workflowTemplate('best-of-n', ROUTES, { count: 4 })
    expect({ ...fromRequest, template: 'best-of-n' }).toEqual(fromTemplate)
  })
})

describe('Discover’s Verify', () => {
  it.each(['quick', 'thorough'] as const)(
    'reviews by impact with no JEV screen, and JEV verify live, discarding only at 0.1 (%s)',
    (depth) => {
      const verify = workflowTemplate('discover', ROUTES, { depth }).steps.find(
        (step) => step.id === 'verify'
      )!
      expect(verify.forEach).toEqual({
        step: 'find',
        limit: 40,
        order: 'impact',
        merge: 'root-cause'
      })
      expect(verify.escalate).toEqual({ max: 8, crossFamily: true, standIn: true })
      expect(verify.jevVerify).toEqual({ mode: 'live', rejectAt: 0.1 })
      expect(workflowJevRejectAt(verify.jevVerify)).toBe(0.1)
      expect(workflowJevConfirmAt(verify.jevVerify)).toBeUndefined()
    }
  )

  it('scouts and finds on Haiku 5.5, and leaves the brief, Verify and the report on each family default', () => {
    const spec = workflowTemplate('discover', ROUTES)
    const models = (id: string) =>
      spec.steps
        .find((step) => step.id === id)!
        .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)
    expect(models('brief')).toEqual(['claude:'])
    expect(models('scout')).toEqual(['claude:claude-haiku-5-5'])
    expect(models('find')).toEqual([
      'claude:claude-haiku-5-5',
      'claude:claude-haiku-5-5',
      'claude:claude-haiku-5-5'
    ])
    expect(spec.steps.find((step) => step.id === 'find')!.agents.map((a) => a.angle)).toEqual([
      'lens 1 from the brief',
      'lens 2 from the brief',
      'lens 3 from the brief'
    ])
    // Another family checks first, so a Haiku finding is never only checked by Claude.
    expect(models('verify')).toEqual(['codex:', 'grok:', 'claude:'])
    expect(models('report')).toEqual(['claude:'])
    expect(validateWorkflowSpec(spec, { available: ROUTES })).toMatchObject({
      problems: [],
      warnings: []
    })
  })

  it('keeps the old lineup when Claude is not set up', () => {
    const spec = workflowTemplate('discover', ['codex', 'grok'])
    const find = spec.steps.find((step) => step.id === 'find')!
    expect(find.agents.map((agent) => agent.route)).toEqual(['codex', 'grok', 'codex'])
    expect(find.agents.every((agent) => agent.model === undefined)).toBe(true)
    expect(spec.steps.find((step) => step.id === 'scout')!.agents).toEqual([{ route: 'codex' }])
  })

  it('keeps the old lineup where no other family could check a Haiku finding', () => {
    // Gemini cannot verify, so Claude stays free to check what Gemini finds.
    const find = (routes: WorkflowRoute[]) =>
      workflowTemplate('discover', routes)
        .steps.find((step) => step.id === 'find')!
        .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)
    expect(find(['claude', 'gemini'])).toEqual(['gemini:', 'gemini:', 'gemini:'])
    // A single-family template remains editable, but thorough admission refuses it.
    expect(find(['claude'])).toEqual(Array(3).fill('claude:'))
  })

  it('pairs Haiku 5.5 with Gemini 3.8 Flash in Find when Gemini and cross-family verifiers are available', () => {
    const allRoutes: WorkflowRoute[] = ['claude', 'codex', 'grok', 'gemini']
    const spec = workflowTemplate('discover', allRoutes)
    const find = spec.steps.find((step) => step.id === 'find')!
    expect(find.agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)).toEqual([
      'claude:claude-haiku-5-5',
      'gemini:gemini-3.8-flash',
      'claude:claude-haiku-5-5'
    ])
    expect(validateWorkflowSpec(spec, { available: allRoutes })).toMatchObject({
      problems: [],
      warnings: []
    })
  })

  it('sets aside by default only when a live step sets neither threshold', () => {
    expect(workflowJevRejectAt({ mode: 'live' })).toBe(0.1)
    expect(workflowJevRejectAt({ mode: 'live', confirmAt: 0.9 })).toBeUndefined()
    expect(workflowJevRejectAt({ mode: 'live', confirmAt: 0.9, rejectAt: 0.05 })).toBe(0.05)
    expect(workflowJevRejectAt({ mode: 'shadow' })).toBeUndefined()
  })
})
