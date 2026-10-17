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

async function main() {
  const [mode, directory] = process.argv.slice(2)
  if (!['live', 'replay'].includes(mode) || !directory || !existsSync(directory)) {
    throw new Error('Expected live|replay and an existing disposable directory')
  }
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const snapshot: WorkflowProgramSnapshot = {
    version: 1,
    task: {
      prompt:
        'Recommend whether this small team should enable the proposed notification default. Use only the evidence. Be concise, cite packet references, and distinguish unknowns from facts.',
      evidence: JSON.stringify([
        {
          ref: 'packet:1',
          text: 'An internal app has 12 users. Notifications are currently opt-in. Four users opted in and say they are useful.'
        },
        {
          ref: 'packet:2',
          text: 'The proposal enables all notifications by default. Each user receives about 20 notifications daily. Urgent and routine notices currently share one category.'
        },
        {
          ref: 'packet:3',
          text: 'The team can instead pilot urgent-only defaults after separating categories. No measured response-time or interruption data exists.'
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
    synthesizerId: 'claude'
  }
  const ledgerPath = join(directory, 'external-launch-ledger.jsonl')
  const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
  if (mode === 'live' && store.findStart('council-service-proof', 'first')) {
    throw new Error('Live proof already exists; inspect it instead of relaunching')
  }
  if (mode === 'replay' && !store.findStart('council-service-proof', 'first')) {
    throw new Error('Replay requires an existing live proof')
  }
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(3),
    reservation: 1,
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
      conversationId: 'council-service-proof',
      requestId: 'first',
      snapshot,
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 7,
      budgetLimit: 21
    })
    const outcome =
      mode === 'live'
        ? await service.wait(executionId)
        : await service.recoverCompleted(executionId, 1)
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
    const report = {
      mode,
      pid: process.pid,
      executionId,
      directory,
      outcome,
      attempts: database.db
        .prepare('SELECT id, call_id, ordinal, state, receipt_json FROM local_workflow_attempts')
        .all(),
      calls: database.db
        .prepare('SELECT call_id, accepted_attempt_id, result_digest FROM local_workflow_calls')
        .all(),
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
        'Diagnostic routes, not certified isolation or returned model attribution.',
        'Allowance counts host attempts, not tokens.',
        'Completed recovery only; crash while live requires process reconciliation.'
      ]
    }
    writeFileSync(join(directory, `${mode}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      JSON.stringify({
        executionId,
        state: outcome.state,
        error: outcome.error,
        report: join(directory, `${mode}-report.json`)
      })
    )
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
