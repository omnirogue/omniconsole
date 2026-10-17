import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowCallStepId } from '../../../../shared/workflow-graph-topology'
import { workflowWebSources, type WorkflowWebSource } from '../../../../shared/workflow-graph-web'
import type { GraphJevRecord } from './graph-jev-store'
import type { GraphItem } from './graph-items'
import type { GraphOutcome, GraphStepRun, GraphTarget } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { checkWebCitations, type GraphWebCheck } from './graph-web-citation-marks'
import { graphWebFenceText } from './graph-web-prompt'
import { graphRunReadsWeb, type GraphWebAnswer, type GraphWebCheckPage } from './graph-web-types'

export type { GraphWebCheck, GraphWebMark } from './graph-web-citation-marks'

/** Every page of the run, whoever quotes it; a page not kept whole is unreadable, never empty. */
export function graphWebCheckPagesOf(
  sources: readonly WorkflowWebSource[],
  outcome: GraphOutcome | undefined
): GraphWebCheckPage[] | 'pending' {
  if (!outcome) {
    return 'pending'
  }
  const value = 'value' in outcome ? (outcome.value as GraphWebAnswer | null) : undefined
  return sources.map(({ id, url }): GraphWebCheckPage => {
    const kept = value?.sources?.find((source) => source.id === id && source.url === url)
    const text = value?.texts?.[id]
    return kept?.state === 'read' && text !== undefined
      ? { id, state: 'read', text }
      : { id, state: 'unreadable' }
  })
}

// Answers are small JSON; the bound only keeps a hostile value from recursing without end.
function strings(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (depth > 8 || !value || typeof value !== 'object') {
    return []
  }
  return (Array.isArray(value) ? value : Object.values(value)).flatMap((entry) =>
    strings(entry, depth + 1)
  )
}

/** The app's checks of every citation in every string a model wrote, in any field. */
export function checkWebValue(
  value: unknown,
  pages: readonly GraphWebCheckPage[] | 'pending'
): GraphWebCheck[] {
  return strings(value).flatMap((text) => checkWebCitations(text, pages))
}

const pagesOf = (scope: GraphScope) =>
  scope.web ? graphWebCheckPagesOf(scope.web.sources, scope.web.outcome) : undefined

/** Keeps the checks of each answer a step settles on; the answer itself is never changed. */
export function graphWebRecorder(
  scope: GraphScope,
  run: GraphStepRun
): ((value: unknown) => void) | undefined {
  const pages = pagesOf(scope)
  if (!pages || pages === 'pending') {
    return undefined
  }
  return (value) => {
    const checks = checkWebValue(value, pages)
    if (checks.length) {
      run.webChecks = [...(run.webChecks ?? []), ...checks]
    }
  }
}

/** How a web run shows model text to a model: fenced, with the app's quote checks after it. */
export function graphWebFencer(
  scope: GraphScope,
  maxBytes?: number
): ((text: string) => string) | undefined {
  const pages = pagesOf(scope)
  return pages
    ? (text) => graphWebFenceText(text, checkWebCitations(text, pages), maxBytes)
    : undefined
}

/** What settling a page-fed item needs: the kept pages, and every step page text reaches. */
export type GraphWebSettling = {
  pages: GraphWebCheckPage[] | 'pending'
  reach: ReadonlySet<string>
}

export const graphWebSettling = (scope: GraphScope): GraphWebSettling | undefined =>
  scope.web
    ? { pages: graphWebCheckPagesOf(scope.web.sources, scope.web.outcome), reach: scope.web.reach }
    : undefined

/** A page-fed item is confirmed only by a quote the app found in its page: votes alone never do. */
export function graphWebSettle<T extends Pick<GraphTarget, 'tally' | 'webUnbacked'>>(
  web: GraphWebSettling,
  item: GraphItem,
  target: T
): T & { webChecks: GraphWebCheck[] } {
  const webChecks = checkWebValue(item, web.pages)
  const fed = web.reach.has(workflowCallStepId(item.sourceCallId))
  const unbacked = fed && (!webChecks.length || webChecks.some((check) => check.mark !== 'found'))
  return {
    ...target,
    webChecks,
    ...(unbacked && target.tally === 'confirmed'
      ? { tally: 'unverified' as const, webUnbacked: true as const }
      : {})
  }
}

/** A target settled on its item as it stands now, every report merged in so far included. */
export function graphWebTarget(scope: GraphScope, target: GraphTarget): GraphTarget {
  const web = graphWebSettling(scope)
  return web ? graphWebSettle(web, target.item, target) : target
}

/** An answer read outside a step's settling (the impact triage's reasons) is checked the same way. */
export function graphWebRecordOutcome(
  scope: GraphScope,
  run: GraphStepRun,
  outcome: GraphOutcome
): void {
  if ('value' in outcome) {
    graphWebRecorder(scope, run)?.(outcome.value)
  }
}

/** A report block's decoded strings checked: what the raw answer hid (escaped JSON) is recorded too. */
export function graphWebReportChecks(
  scope: GraphScope,
  where: string,
  texts: readonly string[],
  raw: string
): GraphWebCheck[] | undefined {
  const pages = pagesOf(scope)
  if (!pages || !scope.web) {
    return undefined
  }
  const key = (check: GraphWebCheck) => JSON.stringify([check.id, check.quote, check.mark])
  const seen = new Set(checkWebCitations(raw, pages).map(key))
  const checks = texts.flatMap((text) => checkWebCitations(text, pages))
  for (const check of checks) {
    if (!seen.has(key(check))) {
      seen.add(key(check))
      scope.web.reportChecks.push({ where, check })
    }
  }
  return checks
}

/** The app's checks of a call's quotes, from its records; the view draws them apart from the answer. */
export function graphWebViewNote(
  snapshot: object,
  host: Readonly<Record<string, GraphJevRecord>> | undefined
): ((value: unknown) => GraphWebCheck[]) | undefined {
  const spec = (snapshot as { graph?: { spec?: WorkflowSpec } }).graph?.spec
  if (!spec || !graphRunReadsWeb(snapshot)) {
    return undefined
  }
  const sources = workflowWebSources(spec)
  const pages = graphWebCheckPagesOf(sources, host?.[`${sources[0]!.readers[0]!}/web`]?.outcome)
  return (value) => checkWebValue(value, pages)
}
