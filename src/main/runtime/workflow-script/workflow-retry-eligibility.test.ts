import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'
import { GraphJevStore } from './graph/graph-jev-store'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'
import {
  localWorkflowFindSpec,
  localWorkflowFindRequestSchema
} from '../../../shared/local-workflow-find-request'
import { setAppEnvironment } from '../../../shared/app-environment'
import type { WorkflowRoute } from '../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { WEB_RULES } from './graph/graph-web-types'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-elig-'))
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
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hasWorkflowRetryableCalls: a Find run with a transient, never-cached screen failure', () => {
  it('is retry-eligible even though none of its host-only calls ever appear in local_workflow_calls, and stops once a real (non-retryable) failure is on record', () => {
    const database = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(database.db)
      const spec = localWorkflowFindSpec(
        localWorkflowFindRequestSchema.parse({ prompt: 'Best crate', items: ['A', 'B'] }),
        ROUTES,
        []
      )
      const id = store.create({
        conversationId: 'find-1',
        requestId: 'req-1',
        snapshot: {
          graphProgramRevision: GRAPH_PROGRAM_REVISION,
          graph: { spec, agentSeats: {} },
          seats: [],
          access: 'frozen',
          task: { prompt: 'Best crate' },
          host: { findRules: 4 }
        },
        preset: 'council',
        fence: 1,
        attemptLimit: 3,
        callLimit: 20,
        budgetLimit: 20
      })
      // The run's screening failed transiently: nothing was ever written to its JEV store, and no
      // agent attempt exists in local_workflow_calls either (screen/jev calls are never one).
      database.db.prepare("UPDATE local_workflow_executions SET state='failed' WHERE id=?").run(id)
      expect(GraphJevStore.forExecution(id).all()).toEqual({})
      expect(hasWorkflowRetryableCalls(database.db, id, 3)).toBe(true)

      // Once the store carries a real, persisted (non-retryable) failure for the screen call,
      // retry is no longer offered on that basis (nothing changed that a retry would fix).
      GraphJevStore.forExecution(id).write('judge/screen', {
        digest: 'd',
        outcome: { value: { markdown: 'x', error: 'no TypeSafe API key' } },
        detail: 'no TypeSafe API key',
        at: Date.now()
      })
      expect(hasWorkflowRetryableCalls(database.db, id, 3)).toBe(false)
    } finally {
      database.db.close()
    }
  })
})

describe('hasWorkflowRetryableCalls: a web run whose pages all failed on something that may pass', () => {
  it('offers Retry while no web record was kept, and only for runs admitted under web rules', () => {
    const database = new OrchestrationDb(':memory:')
    try {
      const store = new WorkflowCheckpointStore(database.db)
      const council = workflowTemplate('council', ROUTES)
      const reading = normalizeWorkflowSpec(
        {
          ...council,
          steps: council.steps.map((step) =>
            step.id === 'answer' ? { ...step, web: { urls: ['https://a.example/one'] } } : step
          )
        },
        ROUTES
      )
      const start = (requestId: string, host: object, spec = reading) =>
        store.create({
          conversationId: `web-${requestId}`,
          requestId,
          snapshot: {
            graphProgramRevision: GRAPH_PROGRAM_REVISION,
            graph: { spec, agentSeats: {} },
            seats: [],
            access: 'frozen',
            task: { prompt: 'Read the pages' },
            host
          },
          preset: 'council',
          fence: 1,
          attemptLimit: 3,
          callLimit: 20,
          budgetLimit: 20
        })
      const web = start('with-web', { webRules: WEB_RULES })
      const plain = start('without-web', {})
      // Web rules on a spec that reads no page plan no web call, so they never offer Retry.
      const rulesOnly = start('rules-only', { webRules: WEB_RULES }, council)
      for (const id of [web, plain, rulesOnly]) {
        database.db
          .prepare("UPDATE local_workflow_executions SET state='failed' WHERE id=?")
          .run(id)
      }
      expect(hasWorkflowRetryableCalls(database.db, web, 3)).toBe(true)
      expect(hasWorkflowRetryableCalls(database.db, plain, 3)).toBe(false)
      expect(hasWorkflowRetryableCalls(database.db, rulesOnly, 3)).toBe(false)
      // Once the pages are kept, a replay reads them from disk: Retry has nothing to read again.
      GraphJevStore.forExecution(web, undefined, 'web-sources.json').write('research/web', {
        digest: 'd',
        outcome: { value: { markdown: 'Read 1 of 1 web page.', sources: [] } },
        at: Date.now()
      })
      expect(hasWorkflowRetryableCalls(database.db, web, 3)).toBe(false)
    } finally {
      database.db.close()
    }
  })
})
