import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPageRead, WebPageReading } from '../../../web-pages/web-page-reader'
import { GraphJevStore } from './graph-jev-store'
import { graphHostCallViews } from './graph-jev-view'
import type { GraphCall } from './graph-plan-types'
import { GRAPH_WEB_CALL_TIMEOUT_MS, type GraphWebReader } from './graph-web-pages'
import {
  createGraphWebSources,
  GraphWebChangedError,
  graphWebHasRetryableFailure
} from './graph-web-sources'
import { GraphWebStore } from './graph-web-store'
import { webResearch } from './graph-web-test-fixtures'
import { GRAPH_WEB_SEAT_ID, WEB_RULES, type GraphWebAnswer } from './graph-web-types'

const RUN = 'run-1'
const CANARY = 'The canary sings only inside the stored page text.'
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-web-sources-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const webFolder = () => join(dir, RUN, 'web')
const store = () => GraphJevStore.forExecution(RUN, dir, 'web-sources.json')
const blobs = () => GraphWebStore.forExecution(RUN, dir)
const calls = () => GraphJevStore.forExecution(RUN, dir, 'web-calls.json')

function webCall(urls: string[], id = 'research/web'): GraphCall {
  return {
    id,
    prompt: '',
    schema: {},
    output: 'text',
    seatId: GRAPH_WEB_SEAT_ID,
    dependencies: [],
    stepId: id.split('/')[0]!,
    round: 1,
    agentIndex: 7,
    web: { rules: WEB_RULES, sources: urls.map((url, index) => ({ id: `W${index + 1}`, url })) },
    validateSemantics: () => null
  }
}

function page(url: string, text: string): WebPageRead {
  const raw = Buffer.from(`<html><title>A title</title><p>${text}</p></html>`)
  return {
    state: 'read',
    text,
    title: 'A title',
    finalUrl: url,
    redirects: [],
    contentType: 'text/html',
    bytes: raw.length,
    rawSha256: sha256(raw),
    textSha256: sha256(text),
    removedLines: 1,
    truncated: false,
    raw,
    fetchedAt: '2026-09-24T10:12:00.000Z'
  }
}

const unreadable = (
  code: 'status' | 'dns' | 'timeout' | 'content-type' | 'network',
  extra: { status?: number; contentType?: string } = {}
): WebPageReading => ({ state: 'unreadable', reason: { code, ...extra }, redirects: [] })

/** Answers each address from `pages`, counting every read. */
function readerOf(pages: Record<string, WebPageReading>) {
  return vi.fn<GraphWebReader>(async (url) => pages[url]!)
}

const never = vi.fn<GraphWebReader>(async () => {
  throw new Error('a replay must never read a page')
})

const valueOf = (outcome: unknown) => (outcome as { value: GraphWebAnswer }).value

describe('the web sources of one run', () => {
  it('reads once, keeps the pages, and a cache-only replay returns the same answer unread', async () => {
    const urls = ['https://a.example/one', 'https://b.example/two']
    const read = readerOf({
      [urls[0]!]: page(urls[0]!, CANARY),
      [urls[1]!]: page(urls[1]!, 'Two.')
    })
    const live = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read
    })(webCall(urls))
    expect(read).toHaveBeenCalledTimes(2)
    expect(valueOf(live).texts).toEqual({ W1: CANARY, W2: 'Two.' })
    expect(store().read('research/web')!.digest).toBe(
      sha256(
        JSON.stringify({
          rules: 1,
          sources: [
            { id: 'W1', url: urls[0] },
            { id: 'W2', url: urls[1] }
          ]
        })
      )
    )
    const replayed = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      cacheOnly: true,
      read: never
    })(webCall(urls))
    expect(replayed).toEqual(live)
    const resumed = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: never
    })(webCall(urls))
    expect(resumed).toEqual(live)
    expect(never).not.toHaveBeenCalled()
  })

  it('keeps page text only in hex-named blobs: never in the record or the log', async () => {
    const url = 'https://a.example/one'
    const log = vi.fn()
    await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      log,
      read: readerOf({ [url]: page(url, CANARY) })
    })(webCall([url]))
    const record = readFileSync(join(dir, RUN, 'web-sources.json'), 'utf8')
    expect(record).not.toContain(CANARY)
    expect(record).not.toContain('"texts"')
    expect(log.mock.calls).toEqual([['Read 1 of 1 web page.']])
    const names = readdirSync(webFolder()).sort()
    expect(names).toEqual([`${sha256(CANARY)}.txt`, `${page(url, CANARY).rawSha256}.raw.gz`].sort())
    expect(names.every((name) => /^[0-9a-f]{64}\.(txt|raw\.gz)$/.test(name))).toBe(true)
  })

  it('refuses a replay when a kept byte changed or a blob is gone, and never reads again', async () => {
    const url = 'https://a.example/one'
    await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: readerOf({ [url]: page(url, CANARY) })
    })(webCall([url]))
    const text = join(webFolder(), `${sha256(CANARY)}.txt`)
    const bytes = readFileSync(text)
    bytes[0] = bytes[0]! ^ 1
    writeFileSync(text, bytes)
    const replay = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      cacheOnly: true
    })
    await expect(replay(webCall([url]))).rejects.toThrow(GraphWebChangedError)
    await expect(replay(webCall([url]))).rejects.toThrow(
      'A stored web page changed or is missing (W1)'
    )
    const live = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: never
    })
    await expect(live(webCall([url]))).rejects.toThrow('(W1)')
    writeFileSync(text, CANARY)
    await expect(replay(webCall([url]))).resolves.toBeTruthy()
    rmSync(join(webFolder(), `${page(url, CANARY).rawSha256}.raw.gz`))
    await expect(replay(webCall([url]))).rejects.toThrow('(W1)')
    expect(never).not.toHaveBeenCalled()
  })

  it('treats a missing record under cache-only as a loud miss, never a read', async () => {
    const replay = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      cacheOnly: true,
      read: never
    })
    await expect(replay(webCall(['https://a.example/']))).rejects.toThrow(
      'Web sources are not recorded: research/web'
    )
    const url = 'https://a.example/one'
    await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: readerOf({ [url]: page(url, 'One.') })
    })(webCall([url]))
    // A record for other pages is refused, never taken for a miss that Resume would read again.
    await expect(replay(webCall(['https://a.example/other']))).rejects.toThrow(
      'The kept web pages are not the ones this run reads (research/web)'
    )
    expect(never).not.toHaveBeenCalled()
  })

  it('writes nothing when every page failed and one failure may pass, and offers Retry', async () => {
    const urls = ['https://a.example/one', 'https://b.example/two']
    const log = vi.fn()
    const outcome = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      log,
      read: readerOf({
        [urls[0]!]: unreadable('dns'),
        [urls[1]!]: unreadable('status', { status: 404 })
      })
    })(webCall(urls))
    expect('texts' in valueOf(outcome)).toBe(false)
    expect(valueOf(outcome)).toMatchObject({
      retryable: true,
      error: expect.stringContaining('Retry reads them again'),
      sources: [
        { id: 'W1', state: 'unreadable', reason: { code: 'dns' } },
        { id: 'W2', state: 'unreadable', reason: { code: 'status', status: 404 } }
      ]
    })
    expect(store().all()).toEqual({})
    expect(existsSync(webFolder())).toBe(false)
    expect(log.mock.calls).toEqual([
      ['No web page could be read (2 tried); nothing was kept, so Retry reads them again.']
    ])
    const snapshot = (host: object, spec = webResearch(urls)) =>
      JSON.stringify({ snapshot: { graph: { spec }, host }, preset: 'council' })
    expect(
      graphWebHasRetryableFailure(snapshot({ webRules: WEB_RULES }), store(), calls(), false)
    ).toBe(true)
    // Web rules alone plan no web call: a spec that reads no page is never offered Retry for one.
    const plain = webResearch([])
    expect(
      graphWebHasRetryableFailure(snapshot({ webRules: WEB_RULES }, plain), store(), calls(), false)
    ).toBe(false)
    expect(graphWebHasRetryableFailure(snapshot({}), store(), calls(), false)).toBe(false)
    expect(graphWebHasRetryableFailure('not json', store(), calls(), false)).toBe(false)
  })

  it('keeps a run whose pages all failed for good, as a failure with its reasons', async () => {
    const urls = ['https://a.example/one', 'https://b.example/two.pdf']
    const read = readerOf({
      [urls[0]!]: unreadable('status', { status: 404 }),
      [urls[1]!]: unreadable('content-type', { contentType: 'application/pdf' })
    })
    const outcome = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read
    })(webCall(urls))
    expect(valueOf(outcome).error).toBe(
      'No web page could be read (W1: the site answered 404; W2: the page is application/pdf, which is not read as text).'
    )
    expect(valueOf(outcome).texts).toEqual({})
    expect(valueOf(outcome).retryable).toBeUndefined()
    const [view] = graphHostCallViews({ web: store().all() })
    expect(view).toMatchObject({
      id: 'research/web',
      stageId: 'research',
      seatId: 'web',
      seatLabel: 'Web',
      state: 'failed',
      error:
        'The web pages could not be read: W1: the site answered 404; W2: the page is application/pdf, which is not read as text'
    })
    const snapshot = JSON.stringify({ snapshot: { host: { webRules: WEB_RULES } } })
    expect(graphWebHasRetryableFailure(snapshot, store(), calls(), false)).toBe(false)
  })

  it('keeps a partly read run with each unreadable page marked, never as content', async () => {
    const urls = ['https://a.example/one', 'https://b.example/two']
    const outcome = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: readerOf({
        [urls[0]!]: page(urls[0]!, 'One.'),
        [urls[1]!]: unreadable('status', { status: 403 })
      })
    })(webCall(urls))
    const value = valueOf(outcome)
    expect(value.error).toBeUndefined()
    expect(value.texts).toEqual({ W1: 'One.' })
    expect(value.sources[1]).toEqual({
      id: 'W2',
      url: urls[1],
      state: 'unreadable',
      reason: { code: 'status', status: 403 },
      redirects: []
    })
    expect(value.sources[0]).toMatchObject({
      id: 'W1',
      state: 'read',
      fetchedAt: '2026-09-24T10:12:00.000Z',
      textSha256: sha256('One.'),
      title: 'A title',
      removedLines: 1,
      truncated: false
    })
    const [view] = graphHostCallViews({ web: store().all() })
    expect(view).toMatchObject({
      state: 'completed',
      resultMarkdown: 'Read 1 of 2 web pages.\nW2 could not be read: the site answered 403.'
    })
    expect(view!.error).toBeUndefined()
  })

  it('reads at most 4 pages at once and 2 from one site', async () => {
    const urls = [
      ...[1, 2, 3, 4].map((n) => `https://a.example/${n}`),
      ...[1, 2, 3].map((n) => `https://b.example/${n}`),
      'https://c.example/1',
      'https://d.example/1'
    ]
    const open = new Map<string, number>()
    let running = 0
    let most = 0
    const mostPerSite = new Map<string, number>()
    const read = vi.fn<GraphWebReader>(async (url) => {
      const site = new URL(url).hostname
      running += 1
      open.set(site, (open.get(site) ?? 0) + 1)
      most = Math.max(most, running)
      mostPerSite.set(site, Math.max(mostPerSite.get(site) ?? 0, open.get(site)!))
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
      open.set(site, open.get(site)! - 1)
      return page(url, `Text of ${url}`)
    })
    const outcome = await createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read
    })(webCall(urls))
    expect(read).toHaveBeenCalledTimes(urls.length)
    expect(most).toBe(4)
    expect(Math.max(...mostPerSite.values())).toBe(2)
    expect(Object.keys(valueOf(outcome).texts!)).toHaveLength(urls.length)
  })

  it('ends at the 90 s limit with every unfinished page a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const urls = ['https://a.example/fast', 'https://b.example/slow']
    const signals: AbortSignal[] = []
    const read = vi.fn<GraphWebReader>((url, { signal }) => {
      signals.push(signal)
      if (url.endsWith('fast')) {
        return Promise.resolve(page(url, 'Fast.'))
      }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const pending = createGraphWebSources({ store: store(), calls: calls(), blobs: blobs(), read })(
      webCall(urls)
    )
    await vi.advanceTimersByTimeAsync(GRAPH_WEB_CALL_TIMEOUT_MS - 1)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const value = valueOf(await pending)
    expect(value.texts).toEqual({ W1: 'Fast.' })
    // The call's own limit, told apart from a page's 15 seconds in every wording of it.
    expect(value.sources[1]).toMatchObject({
      state: 'unreadable',
      reason: { code: 'timeout', limit: 'call' }
    })
    expect(value.markdown).toContain(
      'W2 could not be read: the 90 seconds allowed for reading all the pages ran out first.'
    )
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(Object.keys(store().all())).toEqual(['research/web'])
  })

  it('keeps nothing when the run is stopped mid-read, even if a read never ends', async () => {
    const stop = new AbortController()
    const signals: AbortSignal[] = []
    const read = vi.fn<GraphWebReader>((url, { signal }) => {
      signals.push(signal)
      return url.endsWith('one')
        ? Promise.resolve(page(url, CANARY))
        : new Promise<WebPageReading>(() => {})
    })
    const pending = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      signal: stop.signal,
      read
    })(webCall(['https://a.example/one', 'https://b.example/two']))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    stop.abort(new Error('Stopped by the person'))
    await expect(pending).rejects.toThrow('Stopped by the person')
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(store().all()).toEqual({})
    expect(calls().all()).toEqual({})
    expect(existsSync(webFolder())).toBe(false)
    const again = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      signal: stop.signal,
      read
    })
    await expect(again(webCall(['https://a.example/one']))).rejects.toThrow('Stopped by the person')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('refuses a malformed request before reading anything', async () => {
    const answer = createGraphWebSources({
      store: store(),
      calls: calls(),
      blobs: blobs(),
      read: never
    })
    const call = webCall(['https://a.example/one', 'https://a.example/two'])
    await expect(
      answer({ ...call, web: { ...call.web!, sources: call.web!.sources.toReversed() } })
    ).rejects.toThrow('do not run W1…Wn in order')
    await expect(
      answer({
        ...call,
        web: {
          rules: 1,
          sources: [
            { id: 'W1', url: 'x' },
            { id: 'W2', url: 'x' }
          ]
        }
      })
    ).rejects.toThrow('lists an address twice')
    await expect(answer({ ...call, web: { ...call.web!, rules: WEB_RULES + 1 } })).rejects.toThrow(
      'not known to this build'
    )
    await expect(answer({ ...call, web: { rules: 1, sources: [] } })).rejects.toThrow(
      'names no page'
    )
    expect(never).not.toHaveBeenCalled()
  })
})
