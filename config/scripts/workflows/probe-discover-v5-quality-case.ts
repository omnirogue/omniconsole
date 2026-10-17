import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import { captureWorkflowOwner } from '../../../src/main/runtime/workflow-script/workflow-owner-claim'
import { readWorkflowProcessReceipt } from '../../../src/main/runtime/workflow-script/workflow-process-receipt'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot,
  type WorkflowExecutionOutcome
} from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import { diagnosticCouncilLaunch } from './diagnostic-council-launch'
import { legacyQualityDefaults } from './quality-legacy-defaults'
import { qualityBaseline, type FrozenCase } from './quality-stable-baseline'
import {
  sha,
  sourceFingerprints,
  cliVersions,
  assertStableSource,
  attestClaudePolicy
} from './quality-stable-preflight'

const MANIFEST_SHA = '37e4405f35d010dcae16d5fbebdeff6739b4150073851d6df94538bb222d85e4'

type AttemptRow = {
  id: string
  call_id: string
  ordinal: number
  state: string
  receipt_json: string | null
}

function attempts(db: OrchestrationDb): AttemptRow[] {
  return db.db
    .prepare('SELECT id,call_id,ordinal,state,receipt_json FROM local_workflow_attempts')
    .all() as AttemptRow[]
}
function verifiedSingleFailure(db: OrchestrationDb, directory: string, executionId: string) {
  const unresolved = db.db
    .prepare(
      'SELECT call_id FROM local_workflow_calls WHERE execution_id=? AND accepted_attempt_id IS NULL'
    )
    .all(executionId) as { call_id: string }[]
  if (unresolved.length !== 1) {
    throw new Error(`Explicit repair needs one unresolved call, found ${unresolved.length}`)
  }
  const rows = attempts(db).filter((row) => row.call_id === unresolved[0].call_id)
  const latest = rows.sort((a, b) => b.ordinal - a.ordinal)[0]
  if (!latest || latest.state !== 'failed' || !latest.receipt_json) {
    throw new Error('Failed call lacks a settled terminal attempt')
  }
  const receipt = JSON.parse(latest.receipt_json) as {
    preparedProcess?: { json: string }
  }
  if (!receipt.preparedProcess?.json) {
    throw new Error('Failed call lacks durable process identity')
  }
  const identity = JSON.parse(receipt.preparedProcess.json)
  if (identity.directory !== directory || identity.executionId !== executionId) {
    throw new Error('Failed call process identity differs from this execution')
  }
  const checked = readWorkflowProcessReceipt(identity)
  if (checked.receipt.liveness !== 'exited') {
    throw new Error('Failed call process exit is unverifiable')
  }
  return { callId: latest.call_id, attemptId: latest.id, terminal: checked.result }
}
async function main() {
  const [caseId, directory, expectedHead, mode] = process.argv.slice(2)
  if (
    !/^discover-v5-0[1-6]$/.test(caseId) ||
    !directory ||
    !expectedHead ||
    mode !== '--repair-verified'
  ) {
    throw new Error('Expected frozen case, new directory, exact HEAD and --repair-verified')
  }
  if (existsSync(directory)) {
    throw new Error('Quality directory exists; inspect it instead of relaunching')
  }
  const manifestBytes = readFileSync('docs/workflows/quality-gate-discover-v5-2026-09-21.json')
  if (sha(manifestBytes) !== MANIFEST_SHA) {
    throw new Error('Frozen quality manifest changed')
  }
  const frozen = (JSON.parse(manifestBytes.toString()) as { cases: FrozenCase[] }).cases.find(
    (item) => item.id === caseId
  )!
  const preset = 'discover'
  const defaults = legacyQualityDefaults(preset, { discoverProgramRevision: 4 })
  const fingerprints = sourceFingerprints()
  attestClaudePolicy()
  assertStableSource(expectedHead, fingerprints)
  const versions = cliVersions()
  if (
    versions.claude !== '2.1.278 (Claude Code)' ||
    versions.codex !== 'codex-cli 0.155.1' ||
    versions.grok !== 'grok 1.0.40 (eb1a2256660d) [stable]'
  ) {
    throw new Error('Frozen workflow CLI roster changed')
  }
  mkdirSync(directory)
  const db = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(db.db)
  const owner = await captureWorkflowOwner(`stable-quality:${sha(directory).slice(0, 20)}`)
  const snapshot: WorkflowProgramSnapshot = {
    version: 1,
    discoverProgramRevision: 4,
    limits: { concurrency: defaults.concurrency },
    task: { prompt: frozen.prompt, evidence: JSON.stringify(frozen.evidence) },
    seats: [
      {
        id: 'claude',
        agent: 'claude',
        accountId: 'system:claude',
        model: 'claude-sonnet-5',
        effort: 'low',
        lineage: 'anthropic',
        policyRevision: `stable-${fingerprints['src/shared/workflow-claude-command.ts']}`
      },
      {
        id: 'codex',
        agent: 'codex',
        accountId: 'system:codex',
        model: 'gpt-5.6-sol',
        effort: 'low',
        lineage: 'openai',
        policyRevision: `stable-${expectedHead}`
      },
      {
        id: 'grok',
        agent: 'grok',
        accountId: 'system:grok',
        model: 'grok-4.6',
        effort: null,
        lineage: 'xai',
        policyRevision: `stable-${expectedHead}`
      }
    ],
    synthesizerId: 'claude',
    discover: defaults.discover
  }
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(defaults.concurrency),
    reservation: 1,
    attemptsPerRun: 1,
    launch: (frozenSnapshot, id, fence) =>
      diagnosticCouncilLaunch(directory, frozenSnapshot, id, fence),
    progress: (_id, event) => console.log(JSON.stringify(event))
  })
  const outcomes: {
    step: string
    outcome: WorkflowExecutionOutcome
    at: string
    verifiedFailure?: unknown
  }[] = []
  let executionId = ''
  const reportPath = join(directory, 'quality-report.json')
  let repairStoppedReason: string | null = null
  const persist = (final: WorkflowExecutionOutcome, baselines?: unknown) => {
    const ledgerPath = join(directory, 'external-launch-ledger.jsonl')
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          caseId,
          preset,
          executionId,
          sourceHead: expectedHead,
          sourceFingerprints: fingerprints,
          manifestSha256: MANIFEST_SHA,
          cliVersions: versions,
          limits: {
            discoverProgramRevision: 4,
            callLimit: defaults.callLimit,
            attemptLimit: defaults.attemptLimit,
            budgetLimit: defaults.maxHostAttempts,
            attemptsPerRun: 1,
            concurrency: defaults.concurrency,
            discover: defaults.discover
          },
          firstOutcome: outcomes[0]?.outcome,
          outcomes,
          finalOutcome: final,
          baselines: baselines ?? null,
          repairStoppedReason,
          attempts: attempts(db),
          ledger,
          caveat:
            'CLI-backed durable service quality evidence; separate public Electron/RPC route proof required.'
        },
        null,
        2
      )}\n`
    )
  }
  try {
    executionId = service.start({
      conversationId: `stable-quality-${caseId}`,
      requestId: 'first',
      owner,
      snapshot,
      preset,
      fence: 1,
      attemptLimit: defaults.attemptLimit,
      callLimit: defaults.callLimit,
      budgetLimit: defaults.maxHostAttempts
    })
    let outcome = await service.wait(executionId)
    outcomes.push({ step: 'first-attempt', outcome, at: new Date().toISOString() })
    persist(outcome)
    for (let repair = 1; outcome.state === 'failed' && repair <= 2; repair++) {
      try {
        const verifiedFailure = verifiedSingleFailure(db, directory, executionId)
        assertStableSource(expectedHead, fingerprints)
        const fence = await store.claimOwner(executionId, repair, owner)
        store.retryFailed(executionId, fence)
        service.resume(executionId, fence)
        outcome = await service.wait(executionId)
        outcomes.push({
          step: `explicit-repair-${repair}`,
          outcome,
          at: new Date().toISOString(),
          verifiedFailure
        })
        persist(outcome)
      } catch (error) {
        repairStoppedReason = error instanceof Error ? error.message : String(error)
        persist(outcome)
        break
      }
    }
    assertStableSource(expectedHead, fingerprints)
    const baselines = {
      low: await qualityBaseline(frozen, preset, directory, 'low'),
      high: await qualityBaseline(frozen, preset, directory, 'high')
    }
    assertStableSource(expectedHead, fingerprints)
    persist(outcome, baselines)
    console.log(
      JSON.stringify({ caseId, state: outcome.state, steps: outcomes.length, reportPath })
    )
    if (outcome.state !== 'completed' || baselines.low.error || baselines.high.error) {
      process.exitCode = 1
    }
  } finally {
    db.close()
  }
}
void main()
