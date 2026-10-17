import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import {
  workflowStepReadsWeb,
  type WorkflowSpec,
  type WorkflowStep
} from '../../../../shared/workflow-graph'
import { validateWeb } from '../../../../shared/workflow-graph-validate-web'
import { webPageReasonText } from '../../../../shared/web-page-reason'
import {
  workflowWebReach,
  workflowWebSources,
  type WorkflowWebSource
} from '../../../../shared/workflow-graph-web'
import {
  graphPlural,
  type GraphCall,
  type GraphOutcome,
  type GraphRunOutcome,
  type GraphStepRun
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import type { GraphWebCheck } from './graph-web-citation-marks'
import { graphWebAppendix, graphWebLegendText } from './graph-web-prompt'
import {
  GRAPH_WEB_SEAT_ID,
  WEB_RULES,
  type GraphWebAnswer,
  type GraphWebPage
} from './graph-web-types'

/** The run's one web call, planned before any step, and what it answered once it has. */
export type GraphWebPlan = {
  call: GraphCall
  sources: WorkflowWebSource[]
  outcome?: GraphOutcome
  /** Checks of the report's decoded blocks (claims, ranking), made while the outcome is built. */
  reportChecks: { where: string; check: GraphWebCheck }[]
  /** Every step page text can reach (workflowWebReach): what they produce rests on a page. */
  reach: ReadonlySet<string>
}

/** Like Scan's guard: a spec that reads pages runs and replays only under rules this build knows. */
export function assertWebReplaySupported(spec: WorkflowSpec, webRules: number | undefined): void {
  if (!spec.steps.some((step) => step.web)) {
    return
  }
  if (webRules === undefined) {
    throw new Error("This run reads web pages but was admitted without web rules, so it can't run.")
  }
  if (!Number.isInteger(webRules) || webRules < 1 || webRules > WEB_RULES) {
    throw new Error(`This run reads web pages under rules ${webRules}; open it in a newer build.`)
  }
  const problems: string[] = []
  validateWeb(spec, (message) => problems.push(message))
  if (problems.length) {
    throw new Error(`This run's web pages break the rules: ${problems.join(' ')}`)
  }
}

/** `<firstReader>/web`: every page of the run, read by the app before any reader starts. */
export function planGraphWebSources(scope: GraphScope): void {
  const { spec, webRules } = scope.config
  assertWebReplaySupported(spec, webRules)
  const sources = workflowWebSources(spec)
  if (!sources.length) {
    return
  }
  const reader = scope.byId.get(sources[0]!.readers[0]!)!
  const call: GraphCall = {
    id: `${reader.id}/web`,
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_WEB_SEAT_ID,
    dependencies: [],
    stepId: reader.id,
    round: 1,
    agentIndex: reader.agents.length + 3,
    web: { rules: webRules!, sources: sources.map(({ id, url }) => ({ id, url })) },
    validateSemantics: () => null
  }
  scope.calls.push(call)
  const outcome = scope.outcomes.get(call.id)
  scope.web = {
    call,
    sources,
    reportChecks: [],
    reach: workflowWebReach(scope.config.spec),
    ...(outcome ? { outcome } : {})
  }
}

const answerOf = (outcome: GraphOutcome): GraphWebAnswer | undefined => {
  const value = 'value' in outcome ? (outcome.value as GraphWebAnswer | null) : undefined
  return value && Array.isArray(value.sources) ? value : undefined
}

/** A step's own pages; any page the record cannot show whole fails the step, never shows empty. */
export function graphWebPages(
  scope: GraphScope,
  step: WorkflowStep
): GraphWebPage[] | 'pending' | { error: string } | undefined {
  const web = scope.web
  if (!workflowStepReadsWeb(step) || !web) {
    return undefined
  }
  if (!web.outcome) {
    return 'pending'
  }
  const answer = answerOf(web.outcome)
  if (!answer || answer.error) {
    return { error: answer?.error ?? 'the web pages could not be read.' }
  }
  const pages: GraphWebPage[] = []
  for (const { id, url } of web.sources.filter((source) => source.readers.includes(step.id))) {
    const kept = answer.sources.find((source) => source.id === id && source.url === url)
    const text = answer.texts?.[id]
    if (!kept || (kept.state === 'read' && text === undefined)) {
      return { error: `the kept web pages do not include ${id}.` }
    }
    pages.push(
      kept.state === 'read'
        ? {
            id,
            url,
            state: 'read',
            text: text!,
            textSha256: kept.textSha256,
            finalUrl: kept.finalUrl,
            title: kept.title,
            fetchedAt: kept.fetchedAt,
            truncated: kept.truncated
          }
        : { id, url, state: 'unreadable', reason: kept.reason }
    )
  }
  // Another reader's pages never stand in for this one's: with none of its own, it has nothing.
  if (!pages.some((page) => page.state === 'read')) {
    const why = pages.flatMap((page) =>
      page.state === 'read' ? [] : [`${page.id}: ${webPageReasonText(page.reason)}`]
    )
    return { error: `none of its web pages could be read (${why.join('; ')}).` }
  }
  return pages
}

/** A reader waits for its pages and fails with why when none could be read. */
export function graphWebForStep(
  scope: GraphScope,
  step: WorkflowStep,
  run: GraphStepRun
): 'pending' | 'failed' | { callId: string; pages: GraphWebPage[] } | undefined {
  const pages = graphWebPages(scope, step)
  if (pages === 'pending') {
    run.state = 'active'
    return pages
  }
  if (pages && !Array.isArray(pages)) {
    run.state = 'failed'
    run.reason = `${step.title} failed: ${pages.error}`
    return 'failed'
  }
  return pages ? { callId: scope.web!.call.id, pages } : undefined
}

/** What a step reading a reader's answers is told about its sources: host and path only. */
export function graphWebLegend(scope: GraphScope, stepId: string): string | undefined {
  const step = scope.byId.get(stepId)
  const pages = step ? graphWebPages(scope, step) : undefined
  return Array.isArray(pages) && pages.length ? graphWebLegendText(pages) : undefined
}

// A citation of an unreadable page adds nothing: that page is already a gap of its own.
function problemGaps(where: string, checks: readonly GraphWebCheck[]): string[] {
  const of = (mark: GraphWebCheck['mark']) => checks.filter((check) => check.mark === mark)
  const ids = (list: readonly GraphWebCheck[]) => [...new Set(list.map((check) => check.id))]
  const missing = of('not-in-page')
  const partial = of('leaves-out')
  const unknown = ids(of('unknown'))
  return [
    ...(missing.length
      ? [
          `${where}: ${graphPlural(missing.length, 'quote')} ${missing.length === 1 ? 'is' : 'are'} not in the page cited (${ids(missing).join(', ')}).`
        ]
      : []),
    ...(partial.length
      ? [
          `${where}: ${graphPlural(partial.length, 'quote')} ${partial.length === 1 ? 'leaves' : 'leave'} words out, so the app did not check ${partial.length === 1 ? 'it' : 'them'} (${ids(partial).join(', ')}).`
        ]
      : []),
    ...(unknown.length
      ? [
          `${where}: cites ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a web source' : 'are not web sources'} of this run.`
        ]
      : [])
  ]
}

/** Each unreadable page and each quote the app could not find is a gap; a result lists them all. */
export function graphWebOutcome(scope: GraphScope, outcome: GraphRunOutcome): GraphRunOutcome {
  const web = scope.web
  const answer = web?.outcome ? answerOf(web.outcome) : undefined
  const readers = new Set(web?.sources.flatMap((source) => source.readers))
  const read = [...readers].some((id) =>
    scope.runs[id]?.some((run) => run.state !== 'not-run' && run.state !== 'waiting')
  )
  if (!web || !answer || !read) {
    return outcome
  }
  const unread = answer.sources.filter((source) => source.state === 'unreadable')
  const gaps = unread.length
    ? [
        `${unread.length} of ${graphPlural(answer.sources.length, 'web page')} could not be read (${unread.map((source) => source.id).join(', ')}).`
      ]
    : []
  const listed: { where: string; check: GraphWebCheck }[] = []
  for (const step of scope.config.spec.steps) {
    const runs = scope.runs[step.id] ?? []
    for (const run of runs) {
      const where = `${step.title}${runs.length > 1 ? ` (round ${run.round})` : ''}`
      gaps.push(...problemGaps(where, run.webChecks ?? []))
      listed.push(...(run.webChecks ?? []).map((check) => ({ where, check })))
    }
  }
  for (const where of new Set(web.reportChecks.map((entry) => entry.where))) {
    const checks = web.reportChecks.filter((entry) => entry.where === where)
    gaps.push(
      ...problemGaps(
        where,
        checks.map((entry) => entry.check)
      )
    )
    listed.push(...checks)
  }
  const final = outcome.final
  return {
    ...outcome,
    gaps: [...outcome.gaps, ...gaps],
    // The app's part never joins the model's Markdown: an unclosed tag there could swallow it.
    ...(final
      ? {
          final: {
            ...final,
            appendix: [final.appendix, graphWebAppendix(answer.sources, listed)]
              .filter(Boolean)
              .join('\n\n')
          }
        }
      : {})
  }
}
