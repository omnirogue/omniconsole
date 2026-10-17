import type { WebPageReason } from '../../../../shared/web-page-reason'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowReadsWeb } from '../../../../shared/workflow-graph-web'

/** The seat a web call is recorded under: the app reads the pages, never an agent. */
export const GRAPH_WEB_SEAT_ID = 'web'

/** Rules 1: the app reads the person's pages once, before the steps that cite them. */
export const WEB_RULES = 1

/** One run's pages: citation ids W1…Wn in order, each with its normalised address. */
export type GraphWebRequest = { rules: number; sources: { id: string; url: string }[] }

/** What a run keeps about one page: metadata only, never its text. */
export type GraphWebSource =
  | {
      id: string
      url: string
      state: 'read'
      finalUrl: string
      redirects: string[]
      /** ISO 8601, UTC. */
      fetchedAt: string
      contentType: string
      bytes: number
      rawSha256: string
      textSha256: string
      /** Page-written, so only a step that reads the page may ever see it. */
      title: string
      removedLines: number
      truncated: boolean
    }
  | { id: string; url: string; state: 'unreadable'; reason: WebPageReason; redirects: string[] }

/** One page as its readers see it: the kept text of a read page, or why there is none. */
export type GraphWebPage =
  | {
      id: string
      url: string
      state: 'read'
      text: string
      textSha256: string
      finalUrl: string
      title: string
      fetchedAt: string
      truncated: boolean
    }
  | { id: string; url: string; state: 'unreadable'; reason: WebPageReason }

/** A page as the citation checker sees it: only a page kept whole has text to find a quote in. */
export type GraphWebCheckPage = { id: string } & (
  | { state: 'read'; text: string }
  | { state: 'unreadable' }
)

/** A web call's value: the record keeps all of it except `texts`. */
export type GraphWebAnswer = {
  markdown: string
  sources: GraphWebSource[]
  /** Each read page's clean text by id, re-read from its checked blob; absent in the run view. */
  texts?: Record<string, string>
  /** No page was read: the step never takes silence for content. */
  error?: string
  /** Nothing was kept: every page failed and one failure may pass, so Retry reads them again. */
  retryable?: true
}

/** The web rules a run was admitted under, read defensively: older snapshots have none. */
export function graphWebRules(snapshot: object): { webRules?: number } {
  const rules = (snapshot as { host?: { webRules?: unknown } }).host?.webRules
  return typeof rules === 'number' ? { webRules: rules } : {}
}

/** A run plans a web call only when admitted under web rules with a step that reads pages. */
export function graphRunReadsWeb(snapshot: object): boolean {
  const spec = (snapshot as { graph?: { spec?: WorkflowSpec } }).graph?.spec
  return graphWebRules(snapshot).webRules !== undefined && !!spec && workflowReadsWeb(spec)
}
