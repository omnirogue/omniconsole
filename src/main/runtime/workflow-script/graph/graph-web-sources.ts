import { createHash } from 'node:crypto'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowCallStepId } from '../../../../shared/workflow-graph-topology'
import { workflowWebSources } from '../../../../shared/workflow-graph-web'
import { webPageReasonText, type WebPageReasonCode } from '../../../../shared/web-page-reason'
import { readWebPage, type WebPageReading } from '../../../web-pages/web-page-reader'
import { GraphJevStore, type GraphJevRecord } from './graph-jev-store'
import { graphPlural, type GraphCall, type GraphOutcome } from './graph-plan-types'
import { readGraphWebPages, type GraphWebReader } from './graph-web-pages'
import { GraphWebStore } from './graph-web-store'
import type { WorkflowWebStarts } from '../workflow-web-starts'
import {
  graphRunReadsWeb,
  WEB_RULES,
  type GraphWebAnswer,
  type GraphWebRequest,
  type GraphWebSource
} from './graph-web-types'

/** Failures that may pass on their own; a page that failed only this way is worth reading again. */
const TRANSIENT: ReadonlySet<WebPageReasonCode> = new Set(['network', 'dns', 'timeout', 'proxy'])

/** A kept page whose blob is gone or no longer matches its hash: replay refuses, never re-reads. */
export class GraphWebChangedError extends Error {
  constructor(id: string, what = 'A stored web page changed or is missing') {
    super(`${what} (${id})`)
  }
}

export type GraphWebSourcesOptions = {
  store: GraphJevStore
  /** Each web call that started, and whether it was kept: one whose record is lost never reads again. */
  calls: GraphJevStore
  blobs: GraphWebStore
  /** Only what the store already holds: a replay never touches the network. */
  cacheOnly?: boolean
  /** The run's Stop: a stopped call rejects and keeps nothing. */
  signal?: AbortSignal
  /** Counts only: page text never reaches a log. */
  log?: (message: string) => void
  /** The checkpoint records a reader call: the pages were kept, whatever the files now say. */
  readersStarted?: () => boolean
  /** The checkpoint's own record of each web call that began: the truth when the files are lost. */
  starts?: WorkflowWebStarts
  /** Tests only: the app always reads through readWebPage's own address policy. */
  read?: GraphWebReader
}

const readThroughPolicy: GraphWebReader = (url, { signal }) => readWebPage(url, { signal })

function requestProblem(request: GraphWebRequest): string | undefined {
  if (!Number.isInteger(request.rules) || request.rules < 1 || request.rules > WEB_RULES) {
    return `web rules ${String(request.rules)} are not known to this build`
  }
  if (!request.sources.length) {
    return 'it names no page'
  }
  if (request.sources.some((source, index) => source.id !== `W${index + 1}`)) {
    return 'its source ids do not run W1…Wn in order'
  }
  const urls = new Set(request.sources.map((source) => source.url))
  return urls.size === request.sources.length ? undefined : 'it lists an address twice'
}

/** "W3: the site answered 404", for every page that could not be read. */
const unreadOf = (sources: readonly GraphWebSource[]) =>
  sources.flatMap((source) =>
    source.state === 'unreadable' ? [`${source.id}: ${webPageReasonText(source.reason)}`] : []
  )

function answerOf(sources: GraphWebSource[], transient: boolean): GraphWebAnswer {
  const read = sources.filter((source) => source.state === 'read').length
  const markdown = [
    `Read ${read} of ${graphPlural(sources.length, 'web page')}.`,
    ...sources.flatMap((source) =>
      source.state === 'unreadable'
        ? [`${source.id} could not be read: ${webPageReasonText(source.reason)}.`]
        : []
    )
  ].join('\n')
  if (read) {
    return { markdown, sources }
  }
  const why = unreadOf(sources).join('; ')
  return transient
    ? {
        markdown,
        sources,
        error: `No web page could be read, and the failure may pass (${why}). Retry reads them again.`,
        retryable: true
      }
    : { markdown, sources, error: `No web page could be read (${why}).` }
}

/** The record's value with each read page's text re-read from its blob and proven by its hash. */
function hydrate(record: GraphJevRecord, blobs: GraphWebStore, raw = true): GraphOutcome {
  const value = 'value' in record.outcome ? (record.outcome.value as GraphWebAnswer) : undefined
  if (!value || !Array.isArray(value.sources)) {
    throw new GraphWebChangedError('the record')
  }
  const texts: Record<string, string> = {}
  for (const source of value.sources) {
    if (source.state === 'unreadable') {
      continue
    }
    const text = blobs.text(source.textSha256)
    if (text === undefined || (raw && !blobs.hasRaw(source.rawSha256))) {
      throw new GraphWebChangedError(source.id)
    }
    texts[source.id] = text
  }
  return { value: { ...value, texts } }
}

/** One page as the record keeps it; a read page's blobs are written here, before the record. */
function keep(
  entry: { id: string; url: string },
  reading: WebPageReading,
  blobs: GraphWebStore
): GraphWebSource {
  if (reading.state === 'unreadable') {
    return { ...entry, state: 'unreadable', reason: reading.reason, redirects: reading.redirects }
  }
  return {
    ...entry,
    state: 'read',
    finalUrl: reading.finalUrl,
    redirects: reading.redirects,
    fetchedAt: reading.fetchedAt,
    contentType: reading.contentType,
    bytes: reading.bytes,
    rawSha256: blobs.putRaw(reading.raw),
    textSha256: blobs.putText(reading.text),
    title: reading.title,
    removedLines: reading.removedLines,
    truncated: reading.truncated
  }
}

/**
 * The `GraphConfig.readWeb` of one run: each page is read once and kept (blobs, then the record),
 * so a replay re-reads the same text from disk and never the network. When every page failed and
 * one failure may pass, nothing is kept: the step fails with its reason and Retry reads again.
 */
export function createGraphWebSources(options: GraphWebSourcesOptions) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.web!
    const problem = requestProblem(request)
    if (problem) {
      throw new Error(`The web call ${call.id} is malformed: ${problem}.`)
    }
    const sources = request.sources.map(({ id, url }) => ({ id, url }))
    const digest = createHash('sha256')
      .update(JSON.stringify({ rules: request.rules, sources }))
      .digest('hex')
    if (options.store.damaged() || options.calls.damaged()) {
      throw new GraphWebChangedError(call.id, 'The record of the kept web pages is damaged')
    }
    const stored = options.store.read(call.id)
    if (stored) {
      // Its readers may already have read these pages: another set never takes their place.
      if (stored.digest !== digest) {
        throw new GraphWebChangedError(
          call.id,
          'The kept web pages are not the ones this run reads'
        )
      }
      return hydrate(stored, options.blobs)
    }
    // Started or kept, and the record is gone: reading again would swap in other evidence.
    if (options.starts?.has(call.id) || options.calls.read(call.id) || options.readersStarted?.()) {
      throw new GraphWebChangedError(call.id, 'A web call started but its record is missing')
    }
    if (options.cacheOnly) {
      throw new Error(`Web sources are not recorded: ${call.id}`)
    }
    options.signal?.throwIfAborted()
    options.starts?.begin(call.id, digest)
    options.calls.write(call.id, { digest, outcome: { value: 'started' }, at: Date.now() })
    let readings: WebPageReading[]
    try {
      readings = await readGraphWebPages(
        sources.map((source) => source.url),
        options.read ?? readThroughPolicy,
        options.signal
      )
      options.signal?.throwIfAborted()
    } catch (error) {
      // Stopped before anything was kept or read by a step, so the call may start again.
      options.calls.remove(call.id)
      options.starts?.release(call.id)
      throw error
    }
    const read = readings.filter((reading) => reading.state === 'read').length
    const transient = readings.some(
      (reading) => reading.state === 'unreadable' && TRANSIENT.has(reading.reason.code)
    )
    // Blobs before the record, so a record never names a page that is not on disk.
    const kept = sources.map((entry, index) => keep(entry, readings[index]!, options.blobs))
    if (!read && transient) {
      options.calls.remove(call.id)
      options.starts?.release(call.id)
      options.log?.(
        `No web page could be read (${sources.length} tried); nothing was kept, so Retry reads them again.`
      )
      return { value: answerOf(kept, true) }
    }
    const value = answerOf(kept, false)
    const record: GraphJevRecord = {
      digest,
      outcome: { value },
      ...(value.error ? { detail: unreadOf(kept).join('; ') } : {}),
      at: Date.now()
    }
    options.store.write(call.id, record)
    options.calls.write(call.id, { digest, outcome: { value: 'kept' }, at: Date.now() })
    options.log?.(`Read ${read} of ${graphPlural(sources.length, 'web page')}.`)
    return hydrate(record, options.blobs)
  }
}

/** A recorded reader call proves its pages were kept: files lost with power never read again. */
export function graphWebReadersStarted(
  snapshot: object,
  recorded: () => readonly string[]
): { readersStarted?: () => boolean } {
  const spec = (snapshot as { graph?: { spec?: WorkflowSpec } }).graph?.spec
  if (!spec || !graphRunReadsWeb(snapshot)) {
    return {}
  }
  const readers = new Set(workflowWebSources(spec).flatMap((source) => source.readers))
  return { readersStarted: () => recorded().some((id) => readers.has(workflowCallStepId(id))) }
}

/** One run's web reader; its files are opened only when a web call actually comes. */
export function graphWebForExecution(
  executionId: string,
  options: Omit<GraphWebSourcesOptions, 'store' | 'calls' | 'blobs'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let reader: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    reader ??= createGraphWebSources({
      ...options,
      store: GraphJevStore.forExecution(executionId, undefined, 'web-sources.json'),
      calls: GraphJevStore.forExecution(executionId, undefined, 'web-calls.json'),
      blobs: GraphWebStore.forExecution(executionId)
    })
    return reader(call)
  }
}

/** An all-transient failure keeps nothing and releases its start: only then may Retry read again. */
export function graphWebHasRetryableFailure(
  snapshotJson: string,
  store: GraphJevStore,
  calls: GraphJevStore,
  started: boolean
): boolean {
  let snapshot: object
  try {
    snapshot = (JSON.parse(snapshotJson) as { snapshot?: object | null }).snapshot ?? {}
  } catch {
    return false
  }
  // A call still marked started was lost mid-read, not released: that is recovery, not Retry.
  const intact = !store.damaged() && !calls.damaged()
  return (
    graphRunReadsWeb(snapshot) &&
    intact &&
    !started &&
    !Object.keys(store.all()).length &&
    !Object.keys(calls.all()).length
  )
}

/** The view plans with each kept page's text, proven by its hash; a changed page reads as failed. */
export function graphWebViewRecords(
  executionId: string,
  records: Readonly<Record<string, GraphJevRecord>>
): Record<string, GraphJevRecord> {
  return Object.fromEntries(
    Object.entries(records).map(([callId, record]) => {
      try {
        const outcome = hydrate(record, GraphWebStore.forExecution(executionId), false)
        return [callId, { ...record, outcome }]
      } catch {
        return [callId, { ...record, outcome: { failed: true as const } }]
      }
    })
  )
}
