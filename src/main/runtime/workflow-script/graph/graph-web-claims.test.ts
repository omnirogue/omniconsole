import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'
import { anyGraphAnswer, type WebPageFixture } from './graph-web-test-fixtures'
import { WEB_RULES } from './graph-web-types'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
const URL = 'https://a.example/one'
const PAGES: Record<string, WebPageFixture> = { [URL]: { text: 'Prices rise in May.' } }

const investigate = workflowTemplate('investigate', ROUTES)
const spec = normalizeWorkflowSpec(
  {
    ...investigate,
    steps: investigate.steps.map((step) =>
      step.id === 'investigate' ? { ...step, web: { urls: [URL] } } : step
    )
  },
  ROUTES
)

/** One claim the fact-check passes, its location as given, and an answer as given. */
function run(location: string, answer: string, detail = 'The pay button charges twice.') {
  return drive(
    spec,
    (call: GraphCall) => {
      if (call.stepId === 'investigate' && !call.web) {
        return {
          items: [
            {
              title: 'Pay now',
              detail,
              location,
              severity: 'high',
              excerpt: '',
              trigger: 'a double click'
            }
          ]
        }
      }
      return call.stepId === 'answer' ? text(answer) : anyGraphAnswer(spec, PAGES)(call)
    },
    { webRules: WEB_RULES }
  )
}

const claims = (rows: object[]) => `The answer.\n\n\`\`\`claims\n${JSON.stringify(rows)}\n\`\`\``

describe('a claim that rests on a web page', () => {
  it.each([
    ['bold id', '[**W1** \u2026] "fabricated"'],
    ['spaced id', 'per W 1, fabricated'],
    ['a mark the app does not recognise', '(see W1) fabricated']
  ])('stays open when the app recognised no quote to check: %s', (_name, evidence) => {
    const plan = run(
      'src/pay.ts:3',
      claims([{ claim: 'Pay now', status: 'confirmed', evidence, key: 'investigate.r1.1' }])
    )
    const row = plan.outcome?.final?.claims?.[0]
    expect(row).toMatchObject({ claim: 'Pay now', status: 'open', reliesOnWeb: true })
    expect(row?.note).toContain('rests on a web page')
  })

  it('keeps a page-fed claim open however it names the page: the reviewer\u2019s bare address', () => {
    const plan = run(
      URL,
      claims([{ claim: 'Pay now', status: 'confirmed', evidence: URL, key: 'investigate.r1.1' }])
    )
    // The reviewers passed it, but no quote of it was found in its page: the app does not confirm.
    const [target] = plan.runs.factcheck!.at(-1)!.targets!
    expect(target).toMatchObject({ tally: 'unverified', webUnbacked: true, webChecks: [] })
    expect(target!.votes.every((vote) => vote === 'pass')).toBe(true)
    const row = plan.outcome?.final?.claims?.[0]
    expect(row).toMatchObject({ status: 'open', reliesOnWeb: true, webChecks: [] })
  })

  it('confirms a page-fed claim only by a quote the app found in its page', () => {
    const quote = '[W1] "Prices rise in May."'
    const plan = run(
      URL,
      claims([{ claim: 'Pay now', status: 'confirmed', evidence: quote, key: 'investigate.r1.1' }]),
      `The page says so: ${quote}`
    )
    const found = { id: 'W1', mark: 'found', quote: 'Prices rise in May.' }
    expect(plan.runs.factcheck!.at(-1)!.targets![0]).toMatchObject({
      tally: 'confirmed',
      webChecks: [found]
    })
    expect(plan.outcome?.final?.claims?.[0]).toMatchObject({
      status: 'confirmed',
      reliesOnWeb: true
    })
  })

  it('holds the rows the fact-check stands in for to the same gate', () => {
    // No claims block: the fact-check's own row, whose location quotes a page that lacks the words.
    const plan = run('[W1] "fabricated"', 'The answer.')
    const row = plan.outcome?.final?.claims?.[0]
    expect(row).toMatchObject({ claim: 'Pay now', status: 'open', reliesOnWeb: true })
    expect(row?.webChecks).toContainEqual({ id: 'W1', mark: 'not-in-page', quote: 'fabricated' })
    const appendix = plan.outcome!.final!.appendix!
    expect(appendix).toContain('| Evidence, as the model wrote it | App quote check |')
    expect(appendix).toMatch(/\| Pay now \| Open[^|]* \| .* \| W1 NOT in the page \|/)
  })
})
