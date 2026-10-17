import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment
} from '../../../src/shared/app-environment'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import { buildAuditCorpus } from '../../../src/main/runtime/workflow-script/audit/audit-corpus'
import {
  auditCallLimit,
  captureAuditCorpus,
  readAuditSources
} from '../../../src/main/runtime/workflow-script/audit/audit-snapshot'
import { auditFixtureResponse } from './fixtures/audit-pipeline-fixture'

const fixturePath = resolve(__dirname, 'fixtures/native-workflow-fixture.cjs')
const sourceFixture = resolve(__dirname, 'fixtures/audit-sources.jsonl')

export function auditFixtureSnapshot(directory: string): WorkflowProgramSnapshot {
  const sourceFile = join(directory, 'audit-sources.jsonl')
  copyFileSync(sourceFixture, sourceFile)
  const sources = readAuditSources(sourceFile, 'sources-jsonl')
  const bound = Math.max(
    ...sources.map(
      (source) => buildAuditCorpus([source], { maxChunkBytes: 10_000 }).chunks[0].bytes
    )
  )
  const seats: WorkflowProgramSnapshot['seats'] = [
    {
      id: 'claude',
      agent: 'claude',
      accountId: 'fixture-claude',
      model: 'fixture-claude',
      effort: 'low',
      lineage: 'anthropic',
      policyRevision: 'fixture-v1'
    },
    {
      id: 'codex',
      agent: 'codex',
      accountId: 'fixture-codex',
      model: 'fixture-codex',
      effort: 'low',
      lineage: 'openai',
      policyRevision: 'fixture-v1'
    },
    {
      id: 'grok',
      agent: 'grok',
      accountId: 'fixture-grok',
      model: 'fixture-grok',
      effort: null,
      lineage: 'xai',
      policyRevision: 'fixture-v1'
    }
  ]
  return {
    version: 1,
    task: {
      prompt: 'Audit repeated setup work in a synthetic two-computer corpus.',
      evidence: 'Synthetic fixture only; no private transcripts.'
    },
    seats,
    synthesizerId: 'claude',
    audit: {
      version: 1,
      ...captureAuditCorpus(sourceFile, 'sources-jsonl', bound),
      readerSeatId: 'claude',
      reviewerSeatId: 'codex',
      plannerSeatIds: ['claude', 'codex', 'grok'],
      judgeSeatIds: ['codex', 'grok'],
      synthesizerSeatId: 'claude',
      clusterGroups: 2,
      agreementSamples: 1,
      noveltyLenses: ['Repeated work'],
      maxThemes: 3,
      existingFindings: []
    }
  }
}

export async function runAuditPipelineProbe(directory: string) {
  if (existsSync(directory)) {
    throw new Error('Provide a new disposable output directory')
  }
  mkdirSync(directory, { recursive: true })
  const previous = hasAppEnvironment() ? getAppEnvironment() : null
  setAppEnvironment({
    getPath: () => directory,
    getAppPath: () => directory,
    getVersion: () => '0.0.0-fixture',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  try {
    return await runFixture(directory)
  } finally {
    if (previous) {
      setAppEnvironment(previous)
    }
  }
}

async function runFixture(directory: string) {
  const snapshot = auditFixtureSnapshot(directory)
  const databasePath = join(directory, 'audit.db')
  const db = new OrchestrationDb(databasePath)
  const ledgerPath = join(directory, 'external-launch-ledger.jsonl')
  const calls: string[] = []
  const service = new WorkflowExecutionService({
    store: new WorkflowCheckpointStore(db.db),
    slots: new WorkflowScriptSlots(3),
    reservation: 1,
    progress: () => {},
    launch: (_frozen, executionId, fence) =>
      createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        fence,
        hostId: 'audit-fixture-host',
        ownerIncarnation: 'audit-fixture-v1',
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        command: (input) => {
          calls.push(input.call.id)
          const seat = snapshot.seats.find((candidate) => candidate.id === input.call.seatId)!
          return {
            program: process.execPath,
            args: [fixturePath],
            cwd: directory,
            input: JSON.stringify({
              agent: seat.agent,
              model: seat.model,
              attemptId: input.attemptId,
              ledgerPath,
              value: auditFixtureResponse(input.call)
            })
          }
        }
      })
  })
  const callLimit = auditCallLimit(snapshot.audit!)
  let executionId: string
  let outcome: Awaited<ReturnType<WorkflowExecutionService['wait']>>
  let attempts: number
  try {
    executionId = service.start({
      conversationId: 'audit-fixture',
      requestId: 'first',
      snapshot,
      preset: 'discover',
      fence: 1,
      attemptLimit: 3,
      callLimit,
      budgetLimit: callLimit * 3
    })
    outcome = await service.wait(executionId)
    attempts = (
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get() as {
        count: number
      }
    ).count
  } finally {
    db.close()
  }
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
  const launched = ledger.trim()
    ? ledger
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { attemptId: string })
    : []
  let replayMatches = false
  if (outcome.state === 'completed') {
    renameSync(snapshot.audit!.sourceFile, `${snapshot.audit!.sourceFile}.removed`)
    const reopened = new OrchestrationDb(databasePath)
    try {
      const replay = new WorkflowExecutionService({
        store: new WorkflowCheckpointStore(reopened.db),
        slots: new WorkflowScriptSlots(3),
        reservation: 1,
        progress: () => {},
        launch: () => {
          throw new Error('Replay must not construct a process adapter')
        }
      })
      const recovered = await replay.recoverCompleted(executionId, 1)
      replayMatches =
        JSON.stringify(recovered) === JSON.stringify(outcome) &&
        readFileSync(ledgerPath, 'utf8') === ledger
    } finally {
      reopened.close()
    }
  }
  const report = {
    version: 1,
    executionId,
    outcome,
    calls,
    attempts,
    externalLaunches: launched.length,
    uniqueExternalIds: new Set(launched.map((row) => row.attemptId)).size,
    replayMatches,
    sourceRemovedBeforeReplay: !existsSync(snapshot.audit!.sourceFile),
    caveat:
      'Synthetic native-provider envelopes through the real durable service and child-process adapter. This does not measure live-model quality or fleet placement.'
  }
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (require.main === module) {
  const directory = process.argv[2]
  if (!directory) {
    throw new Error('Usage: probe-audit-pipeline.ts <new-output-directory>')
  }
  void runAuditPipelineProbe(resolve(directory)).then((report) => {
    console.log(
      JSON.stringify({
        report: join(resolve(directory), 'report.json'),
        state: report.outcome.state,
        launches: report.externalLaunches,
        replayMatches: report.replayMatches
      })
    )
    if (report.outcome.state !== 'completed' || !report.replayMatches) {
      process.exitCode = 1
    }
  })
}
