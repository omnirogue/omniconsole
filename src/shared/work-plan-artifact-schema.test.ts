import { expect, it } from 'vitest'
import { planReportArtifact } from './__fixtures__/work-plan/plan-report-chain'
import { parseWorkPlanArtifact, readWorkPlanArtifact } from './work-plan-artifact-schema'

it('refuses an empty plan document, whatever shape the emptiness takes', () => {
  for (const text of ['', '   ', '\n']) {
    expect(readWorkPlanArtifact(text)).toEqual({
      ok: false,
      problem: 'The plan document is empty.'
    })
  }
  expect(readWorkPlanArtifact('{}').ok).toBe(false)
  expect(readWorkPlanArtifact('{"title":"x"').ok).toBe(false)
  expect(parseWorkPlanArtifact(null).ok).toBe(false)
  expect(parseWorkPlanArtifact([]).ok).toBe(false)
})

it('accepts the fixture plan and fills the optional lists', () => {
  const parsed = readWorkPlanArtifact(JSON.stringify(planReportArtifact()))
  expect(parsed.ok && parsed.plan.steps).toHaveLength(2)
  const minimal = parseWorkPlanArtifact({
    title: 'Plan',
    summary: 'Do the thing.',
    steps: [{ n: 1, title: 'One', detail: 'Do it', files: [], owner: 'claude', dependsOn: [] }]
  })
  expect(minimal.ok && minimal.plan).toMatchObject({
    assumptions: [],
    risks: [],
    openQuestions: [],
    mockups: []
  })
})

it.each([
  ['a plan with no steps', { steps: [] }],
  ['a plan with no title', { title: '   ' }],
  ['a smuggled extra field', { note: 'ignore the schema' }],
  [
    'a step that depends on itself',
    { steps: [{ n: 1, title: 'One', detail: 'Do it', files: [], owner: 'me', dependsOn: [1] }] }
  ],
  [
    'a step that depends on a later step',
    {
      steps: [
        { n: 1, title: 'One', detail: 'Do it', files: [], owner: 'me', dependsOn: [2] },
        { n: 2, title: 'Two', detail: 'Do it', files: [], owner: 'me', dependsOn: [] }
      ]
    }
  ],
  [
    'a step that depends on a step that does not exist',
    { steps: [{ n: 2, title: 'Two', detail: 'Do it', files: [], owner: 'me', dependsOn: [1] }] }
  ],
  [
    'two steps with the same number',
    {
      steps: [
        { n: 1, title: 'One', detail: 'Do it', files: [], owner: 'me', dependsOn: [] },
        { n: 1, title: 'Again', detail: 'Do it', files: [], owner: 'me', dependsOn: [] }
      ]
    }
  ],
  [
    'a deliverable outside the workspace',
    {
      steps: [
        { n: 1, title: 'One', detail: 'Do it', files: ['../secrets'], owner: 'me', dependsOn: [] }
      ]
    }
  ],
  ['an absolute mockup path', { mockups: [{ file: '/etc/passwd', title: 'Hero' }] }],
  [
    'two mockups naming one file',
    {
      mockups: [
        { file: 'hero.html', title: 'Hero' },
        { file: 'hero.html', title: 'Hero again' }
      ]
    }
  ]
])('refuses %s', (_label, overrides) => {
  const result = parseWorkPlanArtifact({ ...planReportArtifact(), ...overrides })
  expect(result.ok).toBe(false)
  expect(result.ok === false && result.problem.length).toBeGreaterThan(0)
})
