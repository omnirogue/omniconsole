import { expect, it } from 'vitest'
import {
  planReportArtifact,
  planReportChain,
  planReportOutcome,
  planReportRuntime
} from './__fixtures__/work-plan/plan-report-chain'
import { renderWorkPlanHtml } from './work-plan-report'
import { workPlanReportStages } from './work-plan-report-topology'

function render(): string {
  return renderWorkPlanHtml(
    planReportChain(),
    planReportOutcome(),
    planReportArtifact(),
    planReportRuntime()
  )
}

it('folds Sal’s example into stages: ⑂3 → ◇ → ⑂3 → ⚖ → ✨ → ✓', () => {
  const stages = workPlanReportStages(planReportChain(), planReportRuntime(), planReportOutcome())
  expect(
    stages.map(
      (stage) => `${stage.glyph}${stage.title}${stage.parallel ? `⑂${stage.seats.length}` : ''}`
    )
  ).toEqual([
    'research⑂3',
    '◇synthesize',
    '📝plan⑂3',
    '⚖judge',
    '✨improve',
    '✓verify',
    '👤your review'
  ])
  const states = stages.flatMap((stage) => stage.seats.map((seat) => seat.state))
  expect(states.filter((state) => state === 'done')).toHaveLength(4)
  expect(states.filter((state) => state === 'running')).toHaveLength(2)
  expect(states.filter((state) => state === 'queued')).toHaveLength(5)
  expect(stages.find((stage) => stage.current)?.id).toBe('plan')
  expect(stages.at(3)?.seats[0]?.verdictReceipt).toBe('plan-judge:select-winner:1')
})

it('renders the same bytes every time from the same run', () => {
  expect(render()).toBe(render())
})

it('puts the Outcome and its k/n first, and never invents a satisfied entry', () => {
  const html = render()
  const outcome = html.indexOf('Ship the launch page')
  expect(outcome).toBeGreaterThan(-1)
  expect(outcome).toBeLessThan(html.indexOf('Topology'))
  expect(html).toContain('1/2 done when')
  expect(html).toContain('the plan document exists and matches work-plan-v1')
  expect(html).toContain('you approved the plan')
})

it('references nothing off its own disk and sandboxes every mockup', () => {
  const html = render()
  expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
  expect(html).not.toContain('<script')
  expect(html).toContain('<iframe class="mockup" sandbox=""')
  expect(html).toContain('src="hero.html"')
})

it('carries hover metadata for every seat, escaped', () => {
  const html = render()
  expect(html).toContain('<title>claude · claude-model\nstate: done')
  expect(html).toContain('verdict: judge over plan-1, plan-2, plan-3 · select-winner')
  expect(html).toContain('round 1 of 2')
  const hostile = renderWorkPlanHtml(
    {
      ...planReportChain(),
      steps: planReportChain().steps.map((step) =>
        step.id === 'improve' ? { ...step, prompt: '</title><script>alert(1)</script>' } : step
      )
    },
    planReportOutcome(),
    planReportArtifact(),
    planReportRuntime()
  )
  expect(hostile).not.toContain('<script>alert(1)</script>')
  expect(hostile).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
})

it('is a stable document', () => {
  expect(render()).toMatchSnapshot()
})
