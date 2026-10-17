import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPageReading } from '../../../web-pages/web-page-reader'
import { workflowCallDigest } from '../workflow-call-digest'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { GraphJevStore } from './graph-jev-store'
import { planWorkflowGraph, type GraphCall, type GraphOutcome, type GraphPlan } from './graph-plan'
import { runWorkflowGraphProgram } from './graph-program'
import { configFor, fakeContext, research, task, text } from './graph-program-test-harness'
import type { GraphWebReader } from './graph-web-pages'
import { createGraphWebSources } from './graph-web-sources'
import { GraphWebStore } from './graph-web-store'
import { GRAPH_WEB_SEAT_ID, WEB_RULES, type GraphWebAnswer } from './graph-web-types'

// No spec asks for pages yet, so a stand-in planner plans the web call and one reader of it.
vi.mock('./graph-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planWorkflowGraph: vi.fn()
}))

const URLS = ['https://a.example/one', 'https://b.example/two']
const WEB: GraphCall = {
  id: 'research/web',
  prompt: '',
  schema: {},
  output: 'text',
  seatId: GRAPH_WEB_SEAT_ID,
  dependencies: [],
  stepId: 'research',
  round: 1,
  agentIndex: 7,
  web: { rules: WEB_RULES, sources: URLS.map((url, index) => ({ id: `W${index + 1}`, url })) },
  validateSemantics: () => null
}

function reader(answer: GraphWebAnswer): GraphCall {
  const sources = answer.sources.map((source) =>
    source.state === 'read'
      ? `[${source.id}] ${answer.texts?.[source.id] ?? ''}`
      : `${source.id} could not be read`
  )
  return {
    id: 'research/a0',
    prompt: `Cite the pages.\n${sources.join('\n')}`,
    schema: {},
    output: 'text',
    seatId: 'seat-claude',
    dependencies: [WEB.id],
    stepId: 'research',
    round: 1,
    agentIndex: 0,
    validateSemantics: () => null
  }
}

function plan(outcomes: ReadonlyMap<string, GraphOutcome>): GraphPlan {
  const base = { runs: {}, notes: [] }
  const web = outcomes.get(WEB.id)
  if (!web) {
    return { ...base, calls: [WEB], ready: [WEB], settled: false }
  }
  if (!('value' in web)) {
    return {
      ...base,
      calls: [WEB],
      ready: [],
      settled: true,
      outcome: { state: 'failed', error: 'no pages', gaps: [] }
    }
  }
  const call = reader(web.value as GraphWebAnswer)
  if (!outcomes.has(call.id)) {
    return { ...base, calls: [WEB, call], ready: [call], settled: false }
  }
  return {
    ...base,
    calls: [WEB, call],
    ready: [],
    settled: true,
    outcome: { state: 'completed', gaps: [], final: { stepId: 'research', markdown: 'Done.' } }
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-web-program-'))
  vi.mocked(planWorkflowGraph).mockImplementation((_config, _task, outcomes) => plan(outcomes))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

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

async function runWith(readWeb?: (call: GraphCall) => Promise<GraphOutcome>) {
  const { context, calls } = fakeContext(() => text('An answer citing [W1].'))
  await runWorkflowGraphProgram(
    context,
    { ...configFor(research), ...(readWeb ? { readWeb } : {}) },
    task
  )
  return calls
}

const digests = (calls: readonly WorkflowProgramCall[]) =>
  calls.map((call) => workflowCallDigest(call, JSON.stringify({ seat: call.seatId }), 'claude'))

describe('a web call in the graph program', () => {
  it('replays cache-only with the same reader call digests and no page read', async () => {
    const pages: Record<string, WebPageReading> = {
      [URLS[0]!]: page(URLS[0]!, 'First page words.'),
      [URLS[1]!]: { state: 'unreadable', reason: { code: 'status', status: 410 }, redirects: [] }
    }
    const read = vi.fn<GraphWebReader>(async (url) => pages[url]!)
    const store = () => GraphJevStore.forExecution('run-1', dir, 'web-sources.json')
    const blobs = () => GraphWebStore.forExecution('run-1', dir)
    const calls = () => GraphJevStore.forExecution('run-1', dir, 'web-calls.json')
    const live = await runWith(
      createGraphWebSources({ store: store(), calls: calls(), blobs: blobs(), read })
    )
    expect(live.map((call) => call.id)).toEqual(['research/a0'])
    expect(live[0]!.prompt).toContain('[W1] First page words.')
    expect(live[0]!.prompt).toContain('W2 could not be read')
    const throwing = vi.fn<GraphWebReader>(async () => {
      throw new Error('a replay must never read a page')
    })
    const replayed = await runWith(
      createGraphWebSources({
        store: store(),
        calls: calls(),
        blobs: blobs(),
        cacheOnly: true,
        read: throwing
      })
    )
    expect(digests(replayed)).toEqual(digests(live))
    expect(read).toHaveBeenCalledTimes(2)
    expect(throwing).not.toHaveBeenCalled()
  })

  it('never hands a web call to an agent, and fails it when the run has no reader', async () => {
    const { context, calls } = fakeContext(() => text('unused'))
    await expect(runWorkflowGraphProgram(context, configFor(research), task)).rejects.toThrow(
      'no pages'
    )
    expect(calls).toEqual([])
  })
})
