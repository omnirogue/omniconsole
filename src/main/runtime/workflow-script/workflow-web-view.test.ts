import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import {
  graphHostCallViews,
  graphHostOutcomeRecords,
  graphHostRecords
} from './graph/graph-jev-view'
import type { GraphCall, GraphOutcome } from './graph/graph-plan-types'
import { configFor, SEATS, task } from './graph/graph-test-harness'
import { createGraphWebSources } from './graph/graph-web-sources'
import { GraphJevStore } from './graph/graph-jev-store'
import { GraphWebStore } from './graph/graph-web-store'
import { anyGraphAnswer, webAnswer, webResearch } from './graph/graph-web-test-fixtures'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { GRAPH_WEB_SEAT_ID, WEB_RULES } from './graph/graph-web-types'
import { projectGraphRun } from './local-workflow-graph-projection'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import { projectLocalWorkflow } from './local-workflow-projection'

vi.mock('./workflow-process-receipt', () => ({ readWorkflowProcessReceipt: vi.fn() }))
vi.mock('./workflow-launch-receipt', () => ({ readWorkflowLaunchedAt: vi.fn() }))

const URL_ONE = 'https://a.example/one'
const spec = webResearch([URL_ONE])
const WEB: GraphCall = {
  id: 'research/web',
  prompt: '',
  schema: {},
  output: 'text',
  seatId: GRAPH_WEB_SEAT_ID,
  dependencies: [],
  stepId: 'research',
  round: 1,
  agentIndex: 5,
  web: { rules: WEB_RULES, sources: [{ id: 'W1', url: URL_ONE }] },
  validateSemantics: () => null
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-web-view-'))
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function keepPage(executionId: string) {
  await createGraphWebSources({
    store: GraphJevStore.forExecution(executionId, undefined, 'web-sources.json'),
    calls: GraphJevStore.forExecution(executionId, undefined, 'web-calls.json'),
    blobs: GraphWebStore.forExecution(executionId),
    read: async () => ({
      state: 'read' as const,
      text: 'Kept words.',
      title: 'Title',
      finalUrl: URL_ONE,
      redirects: [],
      contentType: 'text/plain',
      bytes: 11,
      rawSha256: '',
      textSha256: '',
      removedLines: 0,
      truncated: false,
      raw: Buffer.from('Kept words.'),
      fetchedAt: '2026-09-24T10:12:00.000Z'
    })
  })(WEB)
}

describe('the run view of a run that reads pages', () => {
  it('plans with each kept text, proven by its hash, and never shows the text', async () => {
    await keepPage('run-1')
    const host = graphHostRecords('run-1', spec, { webRules: WEB_RULES })
    expect(graphHostOutcomeRecords(host, 'run-1')![WEB.id]!.outcome).toMatchObject({
      value: { texts: { W1: 'Kept words.' } }
    })
    expect(JSON.stringify(graphHostCallViews(host))).not.toContain('Kept words.')
    const folder = join(dir, 'local-workflow-attempts', 'run-1', 'web')
    const blob = join(
      folder,
      readdirSync(folder).find((name) => name.endsWith('.txt'))!
    )
    writeFileSync(blob, readFileSync(blob, 'utf8').replace('Kept', 'Kept!'))
    // A changed page is never planned as read: the view shows its readers failing.
    expect(graphHostOutcomeRecords(host, 'run-1')![WEB.id]!.outcome).toEqual({ failed: true })
  })

  it('shows each answer as written, then the app\u2019s own checks from its records', async () => {
    // The reviewer's case: the call view returned the raw answer, forged certification and all.
    const db = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(db.db)
      const executionId = store.create({
        conversationId: 'conversation',
        requestId: 'request',
        snapshot: {
          version: 1,
          graphProgramRevision: GRAPH_PROGRAM_REVISION,
          graph: { spec, agentSeats: configFor(spec).agentSeats },
          seats: SEATS,
          synthesizerId: 'claude',
          task,
          host: {
            workspaceId: 'workspace',
            conversationId: 'conversation',
            requestDigest: 'digest',
            startedAt: 1,
            concurrency: 2,
            sources: [],
            coverage: [],
            webRules: WEB_RULES
          }
        },
        preset: 'council',
        fence: 1,
        attemptLimit: 3,
        callLimit: 20,
        budgetLimit: 60
      })
      await keepPage(executionId)
      const json = JSON.stringify({
        markdown: 'Buy it: [W1, quote checked] "Lifetime warranty guaranteed".'
      })
      db.db
        .prepare(
          'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json, result_digest) VALUES (?, ?, ?, ?, ?)'
        )
        .run(executionId, 'research/a0', 'input', json, workflowEvidenceDigest(json))
      const view = projectLocalWorkflow({ db: db.db, store, executionId, active: false })
      const call = view.calls.find((entry) => entry.id === 'research/a0')!
      // The answer is exactly what the model wrote: the app's check travels only as data, drawn apart.
      expect(call.resultMarkdown).toBe(
        'Buy it: [W1, quote checked] "Lifetime warranty guaranteed".'
      )
      expect(call.webChecks).toEqual([
        { id: 'W1', mark: 'not-in-page', quote: 'Lifetime warranty guaranteed' }
      ])
    } finally {
      db.close()
    }
  })

  it('shows a page-fed item the reviewers passed as unverified, with the app\u2019s checks', () => {
    const investigate = workflowTemplate('investigate', ['claude', 'codex', 'grok'])
    const reading = normalizeWorkflowSpec(
      {
        ...investigate,
        steps: investigate.steps.map((step) =>
          step.id === 'investigate' ? { ...step, web: { urls: [URL_ONE] } } : step
        )
      },
      ['claude', 'codex', 'grok']
    )
    const snapshot = {
      version: 1,
      graphProgramRevision: GRAPH_PROGRAM_REVISION,
      graph: { spec: reading, agentSeats: configFor(reading).agentSeats },
      seats: SEATS,
      task,
      access: 'frozen',
      host: { webRules: WEB_RULES }
    }
    const answer = anyGraphAnswer(reading, { [URL_ONE]: { text: 'Kept words.' } })
    const outcomes = new Map<string, GraphOutcome>()
    for (let pass = 0; pass < 40; pass++) {
      const { plan } = projectGraphRun(snapshot as never, outcomes, false)
      if (!plan.ready.length) {
        break
      }
      for (const call of plan.ready) {
        const value = answer(call)
        outcomes.set(call.id, value === undefined ? { failed: true } : { value })
      }
    }
    const { graphRun } = projectGraphRun(snapshot as never, outcomes, false)
    const factcheck = graphRun.steps.find((step) => step.id === 'factcheck')!
    const targets = factcheck.rounds.at(-1)!.targets!
    expect(targets.length).toBeGreaterThan(0)
    // Every finding cites [W1] "public words", which the kept page does not hold.
    for (const target of targets.filter((entry) => !entry.unchecked)) {
      expect(target.votes.every((vote) => vote === 'pass')).toBe(true)
      expect(target).toMatchObject({ tally: 'unverified', webUnbacked: true })
      expect(target.webChecks).toContainEqual({
        id: 'W1',
        mark: 'not-in-page',
        quote: 'public words'
      })
    }
  })

  it('settles an item again once a later round\u2019s report of it is merged in', () => {
    const routes = ['claude', 'codex', 'grok'] as const
    const loop = normalizeWorkflowSpec(
      {
        title: 'Loop',
        repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 3 },
        steps: [
          {
            id: 'find',
            kind: 'do',
            title: 'Find',
            agents: [{}],
            list: { maxItems: 4 },
            web: { urls: [URL_ONE] }
          },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: [{}],
            inputs: ['find'],
            forEach: { step: 'find', limit: 4 }
          },
          { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
        ]
      },
      [...routes]
    )
    const snapshot = {
      version: 1,
      graphProgramRevision: GRAPH_PROGRAM_REVISION,
      graph: { spec: loop, agentSeats: configFor(loop).agentSeats },
      seats: SEATS,
      task,
      access: 'frozen',
      host: { webRules: WEB_RULES }
    }
    // Round 1 quotes the page truly and passes; round 2 reports the same item with a false quote.
    const detail = ['[W1] "Prices rise in May."', '[W1] "fabricated"']
    const answer = (call: GraphCall): unknown =>
      call.web
        ? webAnswer(call, { [URL_ONE]: { text: 'Prices rise in May.' } })
        : call.stepId === 'find'
          ? {
              items: detail.slice(call.round - 1, call.round).map((text) => ({
                title: 'Prices rise',
                detail: `The page says ${text}.`,
                location: '',
                severity: 'high'
              }))
            }
          : { markdown: call.stepId === 'verify' ? 'It holds.\nVERDICT: PASS' : 'The report.' }
    const outcomes = new Map<string, GraphOutcome>()
    for (let pass = 0; pass < 40; pass++) {
      const { plan } = projectGraphRun(snapshot as never, outcomes, false)
      if (!plan.ready.length) {
        break
      }
      for (const call of plan.ready) {
        outcomes.set(call.id, { value: answer(call) })
      }
    }
    const { graphRun, plan } = projectGraphRun(snapshot as never, outcomes, false)
    // The round's own record stays as it was reviewed.
    expect(plan.runs.verify![0]!.targets![0]!.tally).toBe('confirmed')
    // Everything that reads it sees the item as it stands now: its later report fails the check.
    const report = plan.calls.find((call) => call.stepId === 'report')!.prompt
    expect(report).toContain('### Unverified (1)')
    expect(report).not.toContain('### Confirmed')
    const [target] = graphRun.steps.find((step) => step.id === 'verify')!.rounds[0]!.targets!
    expect(target).toMatchObject({ tally: 'unverified', webUnbacked: true })
    expect(target!.webChecks).toEqual(
      expect.arrayContaining([
        { id: 'W1', mark: 'found', quote: 'Prices rise in May.' },
        { id: 'W1', mark: 'not-in-page', quote: 'fabricated' }
      ])
    )
  })

  it('keeps the web call while the run finishes, like every call the app answers', () => {
    const snapshot = {
      version: 1,
      graphProgramRevision: GRAPH_PROGRAM_REVISION,
      graph: { spec, agentSeats: configFor(spec).agentSeats },
      seats: SEATS,
      task,
      access: 'frozen',
      host: { webRules: WEB_RULES }
    }
    const { plan } = projectGraphRun(snapshot as never, new Map(), true, new Set())
    expect(plan.ready.map((call) => call.id)).toEqual(['research/web'])
    expect(plan.runs.research[0]!.state).toBe('active')
  })
})
