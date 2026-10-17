import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { fitJevText } from '../../../structured-decisions/jev-rank-rubric'
import { drive, text } from './graph-test-harness'
import { anyGraphAnswer, type WebPageFixture } from './graph-web-test-fixtures'
import { WEB_RULES } from './graph-web-types'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
const URL = 'https://a.example/one'
const PAGES: Record<string, WebPageFixture> = { [URL]: { text: 'Prices rise in May.' } }
// The reviewer's case: a valid 47,000-character answer whose quote the page does not hold.
const LONG = `Buy it [W1] "fabricated". ${'x'.repeat(47_000)}`

describe('what JEV reads of an answer in a run that reads pages', () => {
  it.each([
    ['pairwise', 22_000],
    ['rubric', 46_000]
  ] as const)(
    '%s: fits its %i-byte cut, with the fence closed and the check kept',
    (method, limit) => {
      const spec = normalizeWorkflowSpec(
        {
          title: 'Pick',
          steps: [
            {
              id: 'research',
              kind: 'do',
              title: 'Research',
              agents: [{}, {}],
              web: { urls: [URL] }
            },
            {
              id: 'pick',
              kind: 'rank',
              title: 'Pick',
              agents: [{}],
              inputs: ['research'],
              jev: { method, only: true }
            },
            { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'pick'] }
          ]
        },
        ROUTES
      )
      const plan = drive(
        spec,
        (call) =>
          call.stepId === 'research' && !call.web ? text(LONG) : anyGraphAnswer(spec, PAGES)(call),
        { webRules: WEB_RULES }
      )
      const jev = plan.calls.find((call) => call.jev)!.jev!
      expect(jev.candidates).toHaveLength(2)
      for (const { markdown } of jev.candidates) {
        // What JEV cuts to is what it was given: nothing of the app's part is left to cut.
        expect(fitJevText(markdown, limit)).toBe(markdown)
        expect(markdown).toMatch(/\n<<<END MODEL TEXT [0-9a-f]{12}>>>\nApp quote checks/)
        expect(markdown.endsWith('- W1 NOT in the page: "fabricated"')).toBe(true)
      }
    }
  )

  it('fits the screen\u2019s 46,000-byte cut the same way', () => {
    const spec = normalizeWorkflowSpec(
      {
        title: 'Screen',
        steps: [
          {
            id: 'find',
            kind: 'do',
            title: 'Find',
            agents: [{}],
            list: { maxItems: 4 },
            web: { urls: [URL] }
          },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: [{}],
            inputs: ['find'],
            forEach: { step: 'find', limit: 4, screen: { rubric: 'Is it real?' } }
          },
          { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
        ]
      },
      ROUTES
    )
    const plan = drive(
      spec,
      (call) =>
        call.stepId === 'find' && !call.web
          ? { items: [{ title: 'Long', detail: LONG, location: '', severity: 'high' }] }
          : anyGraphAnswer(spec, PAGES)(call),
      { webRules: WEB_RULES }
    )
    const [candidate] = plan.calls.find((call) => call.screen)!.screen!.candidates
    expect(fitJevText(candidate!.text, 46_000)).toBe(candidate!.text)
    expect(candidate!.text.endsWith('- W1 NOT in the page: "fabricated"')).toBe(true)
  })
})
