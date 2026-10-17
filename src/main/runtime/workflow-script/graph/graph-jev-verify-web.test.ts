import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'
import { anyGraphAnswer, type WebPageFixture } from './graph-web-test-fixtures'
import { WEB_RULES } from './graph-web-types'

const URL = 'https://a.example/one'
const PAGES: Record<string, WebPageFixture> = { [URL]: { text: 'Prices rise in May.' } }
const FIRST = {
  title: 'Lost write',
  detail: 'Writes vanish [W1] "Prices rise".',
  location: 'src/a.ts:3',
  severity: 'low'
}

/** A run that reads pages: JEV is sent each finding's first report fenced, as page-fed text. */
function run(second: typeof FIRST) {
  const spec = normalizeWorkflowSpec(
    {
      title: 'Web',
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
          forEach: { step: 'find', limit: 4 },
          jevVerify: { mode: 'live' }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
      ]
    },
    ['claude', 'codex', 'grok']
  )
  const answer = (call: GraphCall) =>
    call.verify
      ? { markdown: 'verified', probabilities: { 'find.r1.1': 0.05 } }
      : call.stepId === 'find' && !call.web
        ? { items: [FIRST, second] }
        : call.stepId === 'verify' && !call.web
          ? text('Could not tell.\nVERDICT: UNSURE')
          : anyGraphAnswer(spec, PAGES)(call)
  const plan = drive(spec, answer, { webRules: WEB_RULES })
  return { plan, request: plan.calls.find((call) => call.verify)!.verify! }
}

describe('live JEV verify in a run that reads pages', () => {
  it('compares merged reports as they were fenced for JEV: a copy of what it read decides', () => {
    const { plan, request } = run({ ...FIRST, severity: 'high' })
    // What JEV read is fenced, so the raw report never equals it.
    expect(request.items[0]!.title).not.toBe(FIRST.title)
    const [target] = plan.runs.verify[0].targets!
    expect(target!.item.alsoReported).toHaveLength(1)
    expect(target).toMatchObject({ tally: 'refuted', refutedBy: 'jev', jevVerify: 0.05 })
    expect(plan.runs.verify[0].jevHeld).toBeUndefined()
  })

  it('still holds a finding with a merged report JEV did not read', () => {
    const { plan } = run({ ...FIRST, detail: 'Retry writes vanish too.' })
    const [target] = plan.runs.verify[0].targets!
    expect(target!.tally).toBe('unverified')
    expect(target!.refutedBy).toBeUndefined()
    expect(plan.runs.verify[0].jevHeld).toEqual({ 'find.r1.1': 1 })
    expect(plan.runs.verify[0].notes).toContain(
      'Verify round 1: JEV left 1 item unverified that it would have decided, as each carries a merged report it did not read: find.r1.1 (p 0.05; 1 merged report JEV did not read).'
    )
  })
})
