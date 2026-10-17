import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { createDurableWorkflowAgent } from '../../../../src/main/runtime/workflow-script/workflow-durable-call'
import {
  createWorkflowProgramContext,
  type WorkflowProgramCall
} from '../../../../src/main/runtime/workflow-script/workflow-program-context'
import { WorkflowScriptSlots } from '../../../../src/main/runtime/workflow-script/workflow-script-slots'
import { createWorkflowLocalProcessLaunch } from '../../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import { workflowUsageTokens } from '../../../../src/main/runtime/workflow-script/workflow-native-result'
import { workflowEvidenceDigest } from '../../../../src/main/runtime/workflow-script/workflow-evidence-digest'
import { auditPortsForExecution } from '../../../../src/main/runtime/workflow-script/audit/audit-host'
import type { WorkflowProgramSnapshot } from '../../../../src/main/runtime/workflow-script/workflow-program-snapshot'
import type { AuditReader } from '../../../../src/shared/workflow-audit-contracts'
import type { AuditCorpus } from '../../../../src/main/runtime/workflow-script/audit/audit-corpus'
import { auditFixtureSnapshot } from '../probe-audit-pipeline'
import { auditFixtureResponse } from '../fixtures/audit-pipeline-fixture'
import { diagnosticCouncilLaunch } from '../diagnostic-council-launch'
import {
  AUDIT_QUALITY_ARMS,
  runAuditQualityArm,
  type AuditQualityArm
} from './audit-quality-program'
import { auditQualityScore, type AuditQualityTrial } from './audit-quality-score'

export const AUDIT_QUALITY_BUDGET = {
  calls: 64,
  attempts: 192,
  wallClockMs: 20 * 60_000,
  concurrency: 3
}
type Options = { directory: string; mode: 'fixture' | 'live'; model?: string; repetitions: number }
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

function fixtureResponse(call: WorkflowProgramCall): unknown {
  if (call.id === 'audit/quality/report') {
    return { markdown: 'Synthetic audit report; quality is unmeasured.' }
  }
  if (call.id !== 'audit/quality/direct') {
    return auditFixtureResponse(call)
  }
  const data = JSON.parse(call.prompt.split('\nDATA\n')[1]) as { corpus: AuditCorpus }
  const findings = data.corpus.chunks.flatMap(
    (chunk) =>
      (
        auditFixtureResponse({
          ...call,
          id: `audit/read/${chunk.id}`,
          prompt: `\nDATA\n${JSON.stringify({ chunk })}`
        }) as AuditReader
      ).findings
  )
  return {
    ...(auditFixtureResponse({
      ...call,
      id: 'audit/merge',
      prompt: `\nDATA\n${JSON.stringify({ findings })}`
    }) as object),
    markdown: 'Synthetic audit report; quality is unmeasured.'
  }
}

async function trial(
  options: Options,
  snapshot: WorkflowProgramSnapshot,
  arm: AuditQualityArm,
  repetition: number,
  inputHash: string
): Promise<AuditQualityTrial> {
  const sampleId = randomUUID()
  const directory = join(options.directory, `trial-${repetition}-${arm}`)
  mkdirSync(directory)
  const began = performance.now()
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: sampleId,
    requestId: 'first',
    snapshot,
    preset: 'discover',
    fence: 1,
    attemptLimit: 3,
    callLimit: AUDIT_QUALITY_BUDGET.calls,
    budgetLimit: AUDIT_QUALITY_BUDGET.attempts
  })
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Preregistered trial time limit exceeded')),
    AUDIT_QUALITY_BUDGET.wallClockMs
  )
  const launch =
    options.mode === 'live'
      ? diagnosticCouncilLaunch(directory, snapshot, executionId, 1)
      : createWorkflowLocalProcessLaunch({
          directory,
          executionId,
          fence: 1,
          hostId: 'audit-quality-fixture',
          ownerIncarnation: sampleId,
          timeoutMs: 10_000,
          maxOutputBytes: 512 * 1024,
          command: (input) => ({
            program: process.execPath,
            args: [resolve(__dirname, '../fixtures/native-workflow-fixture.cjs')],
            cwd: directory,
            input: JSON.stringify({
              agent: 'claude',
              model: 'fixture-claude',
              attemptId: input.attemptId,
              ledgerPath: join(directory, 'launches.jsonl'),
              value: fixtureResponse(input.call)
            })
          })
        })
  const context = createWorkflowProgramContext({
    agent: createDurableWorkflowAgent({
      store,
      executionId,
      fence: 1,
      slots: new WorkflowScriptSlots(AUDIT_QUALITY_BUDGET.concurrency),
      signal: controller.signal,
      reservation: 1,
      seatFingerprint: (id) => JSON.stringify(snapshot.seats.find((seat) => seat.id === id)),
      route: () => 'claude',
      launch,
      closeAdmission: (error) => controller.abort(error)
    }),
    guard: () => controller.signal.throwIfAborted(),
    isFatal: () => controller.signal.aborted,
    phase: () => {},
    log: () => {}
  })
  const ports = auditPortsForExecution(snapshot.audit!, executionId, false, { root: directory })
  const result: AuditQualityTrial = {
    mode: options.mode,
    sampleId,
    arm,
    repetition,
    inputHash,
    state: 'failed',
    error: null,
    answer: null,
    quoteChecks: [],
    resources: { wallClockMs: 0, attempts: 0, tokens: null, costUsd: null, modelIds: [] }
  }
  try {
    result.answer = await runAuditQualityArm(context, snapshot, arm, ports)
    for (const finding of result.answer.findings) {
      const evidence = await ports.checkEvidence(finding.evidence)
      result.quoteChecks.push({
        findingId: finding.id,
        allVerified: evidence.check.allVerified,
        distinctSources: evidence.check.verifiedSourceCount
      })
    }
    result.state = 'completed'
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
    store.finish(executionId, 1, result.state === 'completed')
    const attempts = database.db
      .prepare('SELECT receipt_json FROM local_workflow_attempts')
      .all() as { receipt_json: string | null }[]
    const receipts = attempts.map((attempt) =>
      attempt.receipt_json
        ? (JSON.parse(attempt.receipt_json) as { usage?: unknown; resolvedModels?: string[] })
        : {}
    )
    const tokens = receipts.map((receipt) => workflowUsageTokens(receipt.usage))
    result.resources = {
      wallClockMs: performance.now() - began,
      attempts: attempts.length,
      tokens:
        tokens.length && tokens.every((value) => value !== undefined)
          ? tokens.reduce((sum, value) => sum + value!.input + value!.output, 0)
          : null,
      costUsd: null,
      modelIds: [...new Set(receipts.flatMap((receipt) => receipt.resolvedModels ?? []))]
    }
    database.close()
  }
  save(join(directory, 'result.json'), result)
  return result
}

/** Runs only the bundled development corpus; live inference requires an explicit model and mode. */
export async function runAuditQuality(options: Options) {
  if (
    !Number.isInteger(options.repetitions) ||
    options.repetitions < 1 ||
    options.repetitions > 5
  ) {
    throw new Error('Repetitions must be 1–5')
  }
  if (
    !['live', 'fixture'].includes(options.mode) ||
    (options.mode === 'live' && !options.model?.trim())
  ) {
    throw new Error('Live mode requires an explicit pinned Claude model')
  }
  if (existsSync(options.directory)) {
    throw new Error('Provide a new output directory')
  }
  mkdirSync(options.directory, { recursive: true })
  const snapshot = auditFixtureSnapshot(options.directory)
  snapshot.seats = snapshot.seats.map((seat) => ({
    ...seat,
    agent: 'claude',
    model: options.mode === 'live' ? options.model! : 'fixture-claude',
    effort: 'high',
    lineage: 'anthropic',
    accountId: options.mode === 'live' ? 'configured-local' : 'fixture-claude'
  }))
  const inputHash = workflowEvidenceDigest(
    JSON.stringify({
      task: snapshot.task,
      corpus: snapshot.audit!.corpus,
      reference: snapshot.audit!.reference,
      seats: snapshot.seats
    })
  )
  const manifest = {
    version: 1,
    programRevision: 1,
    caseId: 'audit-setup-development-v1',
    split: 'development',
    mode: options.mode,
    inputHash,
    repetitions: options.repetitions,
    arms: AUDIT_QUALITY_ARMS,
    budget: AUDIT_QUALITY_BUDGET,
    primaryOutcome: 'Independently accepted distinct useful mechanisms with verified quotations',
    frozenSnapshot: snapshot,
    limits: [
      'One synthetic development case; no held-out generalization claim.',
      'Diagnostic local account launcher; provider isolation is not certified.',
      'Model labels, retries, failures, verification and judging count toward resources; prices remain unknown.',
      'External assessor independence and evidence references require separate review.'
    ]
  }
  save(join(options.directory, 'manifest.json'), manifest)
  const trials: AuditQualityTrial[] = []
  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    const order = AUDIT_QUALITY_ARMS.map(
      (_, index) => AUDIT_QUALITY_ARMS[(index + repetition - 1) % 3]
    )
    for (const arm of order) {
      const result = await trial(options, structuredClone(snapshot), arm, repetition, inputHash)
      trials.push(result)
      if (arm === 'direct') {
        save(join(options.directory, `direct-champion-${repetition}.json`), result.answer)
      }
      save(join(options.directory, 'observations.json'), trials)
    }
  }
  const blinded = trials.toSorted((left, right) => left.sampleId.localeCompare(right.sampleId))
  save(
    join(options.directory, 'blind-packets.json'),
    blinded.map((result) => ({
      sampleId: result.sampleId,
      findings: result.answer?.findings ?? [],
      markdown: result.answer?.markdown ?? '',
      failed: result.state === 'failed'
    }))
  )
  save(
    join(options.directory, 'private-route-map.json'),
    trials.map(({ sampleId, arm, repetition }) => ({ sampleId, arm, repetition }))
  )
  save(
    join(options.directory, 'adjudications.pending.json'),
    blinded.map((result) => ({
      sampleId: result.sampleId,
      assessor: '',
      independent: false,
      evidenceRef: '',
      findings: (result.answer?.findings ?? []).map(({ id }) => ({
        findingId: id,
        valid: null,
        useful: null,
        novel: null,
        mechanismId: null
      }))
    }))
  )
  const report = auditQualityScore(trials, [], options.repetitions)
  save(join(options.directory, 'report.json'), report)
  return { trials, report }
}
