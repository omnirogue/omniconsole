import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import { diagnosticCouncilLaunch } from './diagnostic-council-launch'
import { DISCOVER_REVISION } from '../../../src/main/runtime/workflow-script/discover-program-revision'

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  discoverProgramRevision: DISCOVER_REVISION,
  task: {
    prompt:
      'Inspect only the frozen proposal for concrete, high-severity defects. Cite packet references. A dimension with no supported defect should return no findings. Do not infer missing implementation details.',
    evidence: JSON.stringify([
      {
        ref: 'packet:route',
        text: 'GET /projects/:id/report verifies the bearer token signature but does not compare the token project IDs with the requested :id. Any signed-in user can request any project ID.'
      },
      {
        ref: 'packet:data',
        text: 'The report response includes unreleased customer revenue metrics. The route is the only access path discussed in this packet.'
      },
      {
        ref: 'packet:limits',
        text: 'The proposal provides no observations about performance, keyboard interaction, error handling, or other routes.'
      }
    ])
  },
  seats: [
    {
      id: 'claude',
      agent: 'claude',
      model: 'claude-sonnet-5',
      effort: 'low',
      lineage: 'anthropic'
    },
    { id: 'codex', agent: 'codex', model: 'gpt-5.6-sol', effort: 'low', lineage: 'openai' },
    { id: 'grok', agent: 'grok', model: 'grok-4.6', effort: null, lineage: 'xai' }
  ].map((seat) => ({
    ...seat,
    accountId: 'configured-local',
    policyRevision: 'diagnostic-uncertified-v1'
  })) as WorkflowProgramSnapshot['seats'],
  synthesizerId: 'claude',
  discover: {
    dimensions: ['correctness', 'security', 'usability'],
    lenses: ['evidence', 'alternatives'],
    minimumSeverity: 'high',
    maxCandidates: 1,
    // Revision 7 roles; the frozen packet above is attached because access is not workspace-read.
    finderIds: ['codex', 'grok'],
    lensIds: ['security'],
    depth: 'quick',
    focus: [],
    maxAgents: 10
  }
}

async function main(): Promise<void> {
  const [mode, directory] = process.argv.slice(2)
  if (!['live', 'replay'].includes(mode) || !directory || !existsSync(directory)) {
    throw new Error('Expected live|replay and an existing disposable directory')
  }
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const ledgerPath = join(directory, 'external-launch-ledger.jsonl')
  const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
  const existing = store.findStart('discover-service-proof', 'first')
  if ((mode === 'live' && existing) || (mode === 'replay' && !existing)) {
    throw new Error(`Invalid ${mode} proof state; preserve and inspect the existing attempt`)
  }
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(3),
    reservation: 1,
    attemptsPerRun: 1,
    launch: (frozen, id, fence) => {
      if (mode === 'replay') {
        throw new Error('Replay constructed a provider factory')
      }
      return diagnosticCouncilLaunch(directory, frozen, id, fence)
    },
    progress: (_id, event) => console.log(JSON.stringify(event))
  })
  try {
    const executionId = service.start({
      conversationId: 'discover-service-proof',
      requestId: 'first',
      snapshot,
      preset: 'discover',
      fence: 1,
      attemptLimit: 3,
      callLimit: 10,
      budgetLimit: 30
    })
    const outcome =
      mode === 'live'
        ? await service.wait(executionId)
        : await service.recoverCompleted(executionId, 1)
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
    const attempts = database.db
      .prepare('SELECT id, call_id, ordinal, state, receipt_json FROM local_workflow_attempts')
      .all()
    const calls = database.db
      .prepare('SELECT call_id, accepted_attempt_id, result_digest FROM local_workflow_calls')
      .all()
    const report = {
      mode,
      pid: process.pid,
      executionId,
      directory,
      outcome,
      attempts,
      calls,
      budget: database.db
        .prepare('SELECT budget_reserved, budget_limit FROM local_workflow_executions')
        .get(),
      ledger: ledger.trim()
        ? ledger
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
      replayLedgerUnchanged: mode === 'replay' ? ledger === before : null,
      caveats: [
        'Diagnostic routes, not certified isolation or public RPC account selection.',
        'Allowance counts host attempts, not tokens.'
      ]
    }
    writeFileSync(join(directory, `${mode}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ executionId, state: outcome.state, error: outcome.error }))
    if (outcome.state !== 'completed' || (mode === 'replay' && ledger !== before)) {
      process.exitCode = 1
    }
    if (mode === 'replay') {
      const live = JSON.parse(readFileSync(join(directory, 'live-report.json'), 'utf8'))
      if (JSON.stringify(live.outcome) !== JSON.stringify(outcome)) {
        throw new Error('Replay result differs from live result')
      }
    }
  } finally {
    database.close()
  }
}

void main()
