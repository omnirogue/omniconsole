import { describe, expect, it } from 'vitest'
import {
  LOCAL_WORKFLOW_RUN_TEMPLATES,
  isLocalWorkflowRunRequest,
  localWorkflowRunRequestSchema,
  localWorkflowRunSpec,
  localWorkflowStartLabel
} from './local-workflow-run-request'
import { workflowTemplate } from './workflow-graph-templates'

const ROUTES = ['claude', 'codex'] as const

describe('localWorkflowRunSpec', () => {
  it('is the template itself without an override', () => {
    for (const template of LOCAL_WORKFLOW_RUN_TEMPLATES) {
      expect(localWorkflowRunSpec({ template, prompt: 'x' }, ROUTES)).toEqual(
        workflowTemplate(template, ROUTES)
      )
    }
  })

  it('patches steps by id and replaces top-level fields', () => {
    const spec = localWorkflowRunSpec(
      {
        template: 'discover',
        prompt: 'x',
        spec: {
          title: 'Discover, one round',
          repeat: undefined,
          steps: { verify: { title: 'Check' } }
        }
      },
      ROUTES
    )
    expect(spec.title).toBe('Discover, one round')
    expect(spec.steps.find((step) => step.id === 'verify')?.title).toBe('Check')
    expect(spec.steps.map((step) => step.id)).toEqual(
      workflowTemplate('discover', ROUTES).steps.map((step) => step.id)
    )
  })

  it('sets shadow, live or no JEV verify for Discover through a step patch', () => {
    const run = (jevVerify: unknown) =>
      localWorkflowRunSpec(
        { template: 'discover', prompt: 'x', spec: { steps: { verify: { jevVerify } } } },
        ROUTES
      )
    const verify = run({ mode: 'shadow' }).steps.find((step) => step.id === 'verify')!
    const template = workflowTemplate('discover', ROUTES).steps.find(
      (step) => step.id === 'verify'
    )!
    expect(verify.jevVerify).toEqual({ mode: 'shadow' })
    expect(verify.forEach).toEqual(template.forEach)
    // Live by default since 2026-09-27; `null` turns it off.
    expect(template.jevVerify).toEqual({ mode: 'live', rejectAt: 0.1 })
    expect(run(null).steps.find((step) => step.id === 'verify')!.jevVerify).toBeUndefined()
    const live = (jevVerify: unknown) =>
      run(jevVerify).steps.find((step) => step.id === 'verify')!.jevVerify
    expect(live({ mode: 'live' })).toEqual({ mode: 'live' })
    expect(live({ mode: 'live', confirmAt: 0.85 })).toEqual({ mode: 'live', confirmAt: 0.85 })
    expect(live({ mode: 'live', confirmAt: 0.8 })).toEqual({ mode: 'live', confirmAt: 0.8 })
    expect(live({ mode: 'live', confirmAt: 0.99 })).toEqual({ mode: 'live', confirmAt: 0.99 })
    for (const confirmAt of [0.79, 0.995, 1, 0, -1, '0.9', null]) {
      expect(() => run({ mode: 'live', confirmAt }), String(confirmAt)).toThrow(
        "JEV verify's confirmAt must be a number from 0.8 to 0.99"
      )
    }
    expect(live({ mode: 'live', rejectAt: 0.05 })).toEqual({ mode: 'live', rejectAt: 0.05 })
    expect(live({ mode: 'live', rejectAt: 0.2, confirmAt: 0.9 })).toEqual({
      mode: 'live',
      confirmAt: 0.9,
      rejectAt: 0.2
    })
    for (const rejectAt of [0.005, 0.25, 0.9, 0, -1, '0.1', null]) {
      expect(() => run({ mode: 'live', rejectAt }), String(rejectAt)).toThrow(
        "JEV verify's rejectAt must be a number from 0.01 to 0.2"
      )
    }
    expect(() => run({ mode: 'live', rejectAt: 0.9, confirmAt: 0.9 })).toThrow(
      "JEV verify's rejectAt must be below its confirmAt"
    )
    for (const mode of ['shadw', 'LIVE', 'on', undefined]) {
      expect(() => run({ mode }), String(mode)).toThrow('JEV verify\'s mode is "shadow" or "live"')
    }
    expect(() =>
      localWorkflowRunSpec(
        {
          template: 'discover',
          prompt: 'x',
          spec: { steps: { report: { jevVerify: { mode: 'shadow' } } } }
        },
        ROUTES
      )
    ).toThrow('only a review of each item can ask JEV to verify')
  })

  it('builds Discover at the asked depth: quick has no repeat, unsaid is the spec of today', () => {
    const today = workflowTemplate('discover', ROUTES)
    expect(today.repeat).toEqual({
      do: 'find',
      review: 'verify',
      until: 'nothing-new',
      maxRounds: 2
    })
    expect(localWorkflowRunSpec({ template: 'discover', prompt: 'x' }, ROUTES)).toEqual(today)
    expect(
      localWorkflowRunSpec({ template: 'discover', prompt: 'x', depth: 'thorough' }, ROUTES)
    ).toEqual(today)
    const quick = localWorkflowRunSpec(
      { template: 'discover', prompt: 'x', depth: 'quick' },
      ROUTES
    )
    expect(quick).not.toHaveProperty('repeat')
    expect(quick).toEqual(workflowTemplate('discover', ROUTES, { depth: 'quick' }))
    expect(quick.steps).toEqual(today.steps)
    // An override is laid over the quick template, not over today's.
    const patched = localWorkflowRunSpec(
      {
        template: 'discover',
        prompt: 'x',
        depth: 'quick',
        spec: { steps: { verify: { title: 'Check' } } }
      },
      ROUTES
    )
    expect(patched).not.toHaveProperty('repeat')
    expect(patched.steps.find((step) => step.id === 'verify')?.title).toBe('Check')
  })

  it('refuses a depth for every template but Discover', () => {
    for (const template of LOCAL_WORKFLOW_RUN_TEMPLATES) {
      if (template === 'discover') {
        continue
      }
      for (const depth of ['quick', 'thorough'] as const) {
        expect(() => localWorkflowRunSpec({ template, prompt: 'x', depth }, ROUTES)).toThrow(
          `--depth applies to the discover template only, not ${template}.`
        )
      }
    }
  })

  it('names a step the template does not have, and an override that breaks the graph', () => {
    expect(() =>
      localWorkflowRunSpec(
        { template: 'council', prompt: 'x', spec: { steps: { nope: {} } } },
        ROUTES
      )
    ).toThrow('names steps the template does not have: nope')
    expect(() =>
      localWorkflowRunSpec({ template: 'council', prompt: 'x', spec: { steps: [] } }, ROUTES)
    ).toThrow('does not make a valid workflow')
    expect(() =>
      localWorkflowRunSpec(
        { template: 'council', prompt: 'x', spec: { template: 'build-review' } },
        ROUTES
      )
    ).toThrow('cannot change which template runs')
  })
})

describe('the run request', () => {
  it('is told apart from a Find the best request, and checked strictly', () => {
    expect(isLocalWorkflowRunRequest({ template: 'council', prompt: 'x' })).toBe(true)
    expect(isLocalWorkflowRunRequest({ prompt: 'x' })).toBe(false)
    expect(localWorkflowStartLabel({ template: 'council', prompt: 'x' })).toBe(
      'The council workflow'
    )
    expect(localWorkflowStartLabel({ prompt: 'x' })).toBe('Find the best')
    for (const request of [
      { template: 'research-panel', prompt: 'x' },
      // Graph admission refuses Build + Review: it runs through its own executor.
      { template: 'build-review', prompt: 'x' },
      { template: 'council', prompt: '' },
      { template: 'council', prompt: 'x', routes: [] },
      { template: 'council', prompt: 'x', routes: ['hal'] },
      { template: 'council', prompt: 'x', runsOn: 'cloud' },
      { template: 'discover', prompt: 'x', depth: 'deep' },
      { template: 'discover', prompt: 'x', depth: '' },
      { template: 'council', prompt: 'x', surprise: true }
    ]) {
      expect(localWorkflowRunRequestSchema.safeParse(request).success).toBe(false)
    }
  })

  it('accepts where the run executes and leaves it out when unsaid, so the host defaults to the fleet', () => {
    for (const runsOn of ['fleet', 'local'] as const) {
      expect(
        localWorkflowRunRequestSchema.parse({ template: 'council', prompt: 'x', runsOn })
      ).toEqual({ template: 'council', prompt: 'x', runsOn })
    }
    expect(
      localWorkflowRunRequestSchema.parse({ template: 'council', prompt: 'x' })
    ).not.toHaveProperty('runsOn')
  })

  it('accepts a Discover depth and leaves it out when unsaid', () => {
    for (const depth of ['quick', 'thorough'] as const) {
      expect(
        localWorkflowRunRequestSchema.parse({ template: 'discover', prompt: 'x', depth })
      ).toEqual({ template: 'discover', prompt: 'x', depth })
    }
    expect(
      localWorkflowRunRequestSchema.parse({ template: 'discover', prompt: 'x' })
    ).not.toHaveProperty('depth')
  })
})
