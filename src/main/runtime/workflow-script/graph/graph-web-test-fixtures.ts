import { createHash } from 'node:crypto'
import type { WebPageReason } from '../../../../shared/web-page-reason'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { ballot, screened } from './graph-decide-test-fixtures'
import type { GraphCall } from './graph-plan-types'
import { text } from './graph-test-harness'
import type { GraphWebAnswer, GraphWebSource } from './graph-web-types'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** What the app would have kept for one address: its text, or why it could not be read. */
export type WebPageFixture =
  | { text: string; title?: string; truncated?: boolean }
  | { reason: WebPageReason }

/** A web call answered as the store would answer it, texts included, for the planner alone. */
export function webAnswer(call: GraphCall, pages: Record<string, WebPageFixture>): GraphWebAnswer {
  const texts: Record<string, string> = {}
  const sources = call.web!.sources.map(({ id, url }): GraphWebSource => {
    const page = pages[url] ?? { reason: { code: 'network' } }
    if ('reason' in page) {
      return { id, url, state: 'unreadable', reason: page.reason, redirects: [] }
    }
    texts[id] = page.text
    return {
      id,
      url,
      state: 'read',
      finalUrl: url,
      redirects: [],
      fetchedAt: '2026-09-24T10:12:07.000Z',
      contentType: 'text/html',
      bytes: page.text.length,
      rawSha256: sha256(`<html>${page.text}</html>`),
      textSha256: sha256(page.text),
      title: page.title ?? '',
      removedLines: 0,
      truncated: page.truncated ?? false
    }
  })
  const read = sources.filter((source) => source.state === 'read').length
  return {
    markdown: `Read ${read} of ${sources.length} web pages.`,
    sources,
    texts,
    ...(read ? {} : { error: 'No web page could be read (every page failed).' })
  }
}

/** The labels a ranking prompt shows, so any rank or JEV call gets a ballot it can parse. */
function labelsOf(call: GraphCall): string[] {
  const jev = call.jev?.candidates.map((candidate) => candidate.label.slice(-1))
  return jev ?? [...new Set([...call.prompt.matchAll(/Response ([A-H])\b/g)].map((m) => m[1]!))]
}

/** A plausible answer to any call of any template, so every judge of a run actually runs. */
export function anyGraphAnswer(spec: WorkflowSpec, pages: Record<string, WebPageFixture>) {
  return (call: GraphCall): unknown => {
    const step = spec.steps.find((entry) => entry.id === call.stepId)!
    if (call.web) {
      return webAnswer(call, pages)
    }
    if (call.screen) {
      return screened(call)
    }
    if (call.evidence) {
      return { markdown: 'checked', checks: {} }
    }
    if (call.route || call.check || call.id.endsWith('/impact')) {
      return undefined
    }
    if (call.jev || step.kind === 'rank') {
      return ballot(labelsOf(call).join('') || 'AB')
    }
    if (step.kind === 'review') {
      return text('It holds up [W1] "public words".\nVERDICT: PASS')
    }
    if (step.id === 'brief' || step.id === 'frame') {
      return text(
        '## Decision\nPick one.\n## Hard limits\n- Under $500\n## Rubric\n- Is it real?\n- Is it cheap?\n## Scope\nOK'
      )
    }
    if (step.list) {
      return {
        items: [1, 2].map((n) => ({
          title: `Finding ${n} from ${call.id}`,
          detail: `A specific finding ${n}, citing [W1] "public words".`,
          location: '',
          severity: 'high',
          excerpt: '',
          trigger: ''
        }))
      }
    }
    return text(`Answer from ${call.id}, citing [W1] "public words".`)
  }
}

/** A research panel whose first step reads pages: reader, reviewers, one synthesis. */
export const webResearch = (urls: string[], agents = 2): WorkflowSpec =>
  normalizeWorkflowSpec({
    title: 'Research',
    steps: [
      {
        id: 'research',
        kind: 'do',
        title: 'Research',
        agents: Array.from({ length: agents }, () => ({})),
        web: { urls }
      },
      { id: 'critics', kind: 'review', title: 'Critics', agents: [{}, {}], inputs: ['research'] },
      { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
    ]
  })
