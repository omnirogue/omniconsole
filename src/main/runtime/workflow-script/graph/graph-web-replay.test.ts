import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPageReading } from '../../../web-pages/web-page-reader'
import { workflowCallDigest } from '../workflow-call-digest'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { GraphJevStore } from './graph-jev-store'
import { runWorkflowGraphProgram } from './graph-program'
import { configFor, fakeContext, task, text } from './graph-program-test-harness'
import type { GraphWebReader } from './graph-web-pages'
import {
  createGraphWebSources,
  GraphWebChangedError,
  graphWebHasRetryableFailure
} from './graph-web-sources'
import { GraphWebStore } from './graph-web-store'
import { webResearch } from './graph-web-test-fixtures'
import { WEB_RULES } from './graph-web-types'

const ONE = 'https://a.example/one'
const TWO = 'https://b.example/two'
const spec = webResearch([ONE, TWO])

const page = (url: string, words: string): WebPageReading => ({
  state: 'read',
  text: words,
  title: 'Title',
  finalUrl: url,
  redirects: [],
  contentType: 'text/plain',
  bytes: words.length,
  rawSha256: '',
  textSha256: '',
  removedLines: 0,
  truncated: false,
  raw: Buffer.from(words),
  fetchedAt: '2026-09-24T10:12:00.000Z'
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-web-replay-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = () => GraphJevStore.forExecution('run-1', dir, 'web-sources.json')
const blobs = () => GraphWebStore.forExecution('run-1', dir)
const webCalls = () => GraphJevStore.forExecution('run-1', dir, 'web-calls.json')

async function run(read: GraphWebReader, cacheOnly = false) {
  const { context, calls } = fakeContext((call) =>
    text(
      call.id.startsWith('critics/')
        ? 'Sound.\nVERDICT: PASS'
        : `Answer citing [W1] "the kept words" from ${call.id}.`
    )
  )
  const readWeb = createGraphWebSources({
    store: store(),
    calls: webCalls(),
    blobs: blobs(),
    read,
    ...(cacheOnly ? { cacheOnly: true } : {})
  })
  const result = runWorkflowGraphProgram(
    context,
    { ...configFor(spec), webRules: WEB_RULES, readWeb },
    task
  )
  return { result, calls }
}

const digests = (calls: readonly WorkflowProgramCall[]) =>
  calls.map((call) => workflowCallDigest(call, JSON.stringify({ seat: call.seatId }), 'claude'))

const live: GraphWebReader = async (url) =>
  url === ONE
    ? page(url, 'These are the kept words of page one.')
    : { state: 'unreadable', reason: { code: 'status', status: 404 }, redirects: [] }

describe('replaying a run that read pages', () => {
  it('rebuilds the same calls from disk, cache-only, without reading a page', async () => {
    const read = vi.fn(live)
    const first = await run(read)
    const outcome = await first.result
    // The program's result is the plan's final as it settled, the app's own part included.
    expect((outcome.final as { appendix?: string }).appendix).toContain('## Sources')
    expect(outcome.gaps).toContain('1 of 2 web pages could not be read (W2).')
    const never = vi.fn<GraphWebReader>(async () => {
      throw new Error('a replay must never read a page')
    })
    const again = await run(never, true)
    expect(await again.result).toEqual(outcome)
    expect(digests(again.calls)).toEqual(digests(first.calls))
    expect(read).toHaveBeenCalledTimes(2)
    expect(never).not.toHaveBeenCalled()
  })

  it('refuses a kept page that changed, and makes no agent call', async () => {
    await (
      await run(vi.fn(live))
    ).result
    const folder = join(dir, 'run-1', 'web')
    const blob = readdirSync(folder).find((name) => name.endsWith('.txt'))!
    writeFileSync(join(folder, blob), `${readFileSync(join(folder, blob), 'utf8')} Added.`)
    const again = await run(vi.fn(live), true)
    await expect(again.result).rejects.toBeInstanceOf(GraphWebChangedError)
    expect(again.calls).toEqual([])
  })

  it('treats a run with no web record as not recorded when replaying', async () => {
    const again = await run(vi.fn(live), true)
    await expect(again.result).rejects.toThrow('Web sources are not recorded: research/web')
    expect(again.calls).toEqual([])
  })

  it('never reads again once kept pages lose their record: replay and Resume both refuse', async () => {
    // The reviewer's case: read, lose the record, then a cache-only miss let Resume fetch anew.
    const read = vi.fn(live)
    await (
      await run(read)
    ).result
    rmSync(join(dir, 'run-1', 'web-sources.json'))
    for (const cacheOnly of [true, false]) {
      const again = await run(read, cacheOnly)
      await expect(again.result).rejects.toThrow(
        'A web call started but its record is missing (research/web)'
      )
      await expect(again.result).rejects.toBeInstanceOf(GraphWebChangedError)
      expect(again.calls).toEqual([])
    }
    expect(read).toHaveBeenCalledTimes(2)
    const json = JSON.stringify({ snapshot: { graph: { spec }, host: { webRules: WEB_RULES } } })
    expect(graphWebHasRetryableFailure(json, store(), webCalls(), false)).toBe(false)
  })

  it.each(['web-sources.json', 'web-calls.json'])(
    'takes a damaged %s for lost evidence, never for none',
    async (file) => {
      const read = vi.fn(live)
      await (
        await run(read)
      ).result
      writeFileSync(join(dir, 'run-1', file), '{"research/web": ')
      for (const cacheOnly of [true, false]) {
        await expect((await run(read, cacheOnly)).result).rejects.toThrow(
          'The record of the kept web pages is damaged (research/web)'
        )
      }
      expect(read).toHaveBeenCalledTimes(2)
    }
  )

  it('holds a read cut off by a crash for recovery, and never reads it twice', async () => {
    webCalls().write('research/web', { digest: 'd', outcome: { value: 'started' }, at: 1 })
    const read = vi.fn(live)
    for (const cacheOnly of [true, false]) {
      await expect((await run(read, cacheOnly)).result).rejects.toBeInstanceOf(GraphWebChangedError)
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a record kept for other pages instead of reading these', async () => {
    const read = vi.fn(live)
    await (
      await run(read)
    ).result
    const record = store().read('research/web')!
    store().write('research/web', { ...record, digest: 'another request' })
    for (const cacheOnly of [true, false]) {
      await expect((await run(read, cacheOnly)).result).rejects.toThrow(
        'The kept web pages are not the ones this run reads (research/web)'
      )
    }
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing when every page failed on something that may pass, and offers Retry', async () => {
    const offline: GraphWebReader = async () => ({
      state: 'unreadable',
      reason: { code: 'network' },
      redirects: []
    })
    const first = await run(offline)
    await expect(first.result).rejects.toThrow(
      'Research failed: No web page could be read, and the failure may pass'
    )
    expect(first.calls).toEqual([])
    expect(store().all()).toEqual({})
    // Released, not lost: the start is cleared, so Retry may read the pages again.
    expect(webCalls().all()).toEqual({})
    const snapshot = (graph: object, host: object) => JSON.stringify({ snapshot: { graph, host } })
    const plain = webResearch([])
    const retryable = (json: string) =>
      graphWebHasRetryableFailure(
        json,
        GraphJevStore.forExecution('run-1', dir, 'web-sources.json'),
        webCalls(),
        false
      )
    expect(retryable(snapshot({ spec }, { webRules: WEB_RULES }))).toBe(true)
    // Web rules alone never offer Retry: only a spec that reads pages plans a web call.
    expect(retryable(snapshot({ spec: plain }, { webRules: WEB_RULES }))).toBe(false)
    expect(retryable(snapshot({ spec }, {}))).toBe(false)
  })
})
