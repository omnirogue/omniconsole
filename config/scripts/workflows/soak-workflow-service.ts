import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import type { WorkflowAttemptLaunch } from '../../../src/main/runtime/workflow-script/workflow-durable-call'
import { soakCases, type SoakCase, type SoakScenario } from './soak-workflow-cases'

const fixturePath = resolve(__dirname, 'fixtures/native-workflow-fixture.cjs')
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
function valueFor(
  input: Parameters<WorkflowAttemptLaunch>[0],
  scenario: SoakScenario,
  launchNumber: number
) {
  const { call } = input
  const invalid =
    scenario === 'permanent-invalid' || (scenario === 'retry-invalid' && launchNumber === 1)
  if (call.id.startsWith('answers/')) {
    return { markdown: 'Fixture answer', sources: [], uncertainties: [] }
  }
  if (call.id.startsWith('peer/')) {
    const labels = ['Response A', 'Response B', 'Response C'].filter(
      (_, i) => seats[i].id !== call.seatId
    )
    return {
      ranking: invalid && call.id === 'peer/claude' ? [labels[0], labels[0]] : labels,
      assessments: labels.map((label) => ({ label, strengths: 'Supported', weaknesses: 'Limited' }))
    }
  }
  if (call.id === 'synthesis/final') {
    return { markdown: 'Fixture synthesis', sources: [], disagreements: [] }
  }
  if (call.id.startsWith('discover/')) {
    return {
      findings:
        call.id === 'discover/correctness'
          ? [
              {
                issueKey: 'bounded-index',
                title: 'Off-by-one access',
                location: 'src/fixture.ts:2',
                trigger: 'i equals array length',
                impact: 'Undefined element read',
                severity: 'high',
                evidence: [{ ref: 'fixture:1', description: 'The loop uses a closed upper bound' }]
              }
            ]
          : [],
      omittedCount: 0,
      omissionReason: ''
    }
  }
  if (call.id.startsWith('refute/')) {
    const bad = invalid && call.id.endsWith('/evidence')
    return {
      refuted: false,
      uncertain: bad,
      reason: bad ? 'Unknown, cannot confirm' : 'Concrete fixture trigger',
      evidence: []
    }
  }
  const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
    survivors: { id: string }[]
  }
  return {
    summary: 'Fixture ranked survivor',
    ranking: packet.survivors.map(({ id }) => ({
      findingId: id,
      reason: 'Actionable',
      nextAction: 'Fix bound'
    }))
  }
}

async function runCase(testCase: SoakCase, outputRoot: string) {
  const directory = join(outputRoot, testCase.id)
  mkdirSync(directory)
  const db = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(db.db)
  const ledgerPath = join(directory, 'external-launch-ledger.jsonl')
  const snapshot: WorkflowProgramSnapshot = {
    version: 1,
    task: {
      prompt: `${testCase.id}: inspect fixed fixture`,
      evidence: '[{"ref":"fixture:1","text":"A closed upper bound reads past an array."}]'
    },
    seats,
    synthesizerId: 'claude',
    discover: {
      dimensions: ['correctness', 'security', 'usability'],
      lenses: ['evidence', 'alternatives'],
      minimumSeverity: 'high',
      maxCandidates: 1
    }
  }
  const launchCounts = new Map<string, number>()
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(3),
    reservation: 1,
    attemptsPerRun: 3,
    progress: () => {},
    launch: (_frozen, executionId, fence) =>
      createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        fence,
        hostId: 'soak-fixture-host',
        ownerIncarnation: 'soak-2026-09-21',
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        command: (input) => {
          const number = (launchCounts.get(input.call.id) ?? 0) + 1
          launchCounts.set(input.call.id, number)
          const seat = seats.find((candidate) => candidate.id === input.call.seatId)!
          return {
            program: process.execPath,
            args: [fixturePath],
            cwd: directory,
            input: JSON.stringify({
              agent: seat.agent,
              model: seat.model,
              attemptId: input.attemptId,
              ledgerPath,
              value: valueFor(input, testCase.scenario, number)
            })
          }
        }
      })
  })
  try {
    const executionId = service.start({
      conversationId: testCase.id,
      requestId: 'first',
      snapshot,
      preset: testCase.preset,
      fence: 1,
      attemptLimit: 3,
      callLimit: testCase.preset === 'council' ? 7 : 6,
      budgetLimit: 21
    })
    const outcome = await service.wait(executionId)
    const launched = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { attemptId: string; pid: number })
      : []
    const attemptRows = db.db
      .prepare('SELECT id, call_id, ordinal, state FROM local_workflow_attempts')
      .all() as { id: string; call_id: string; ordinal: number; state: string }[]
    const accepted = db.db
      .prepare('SELECT call_id FROM local_workflow_calls WHERE accepted_attempt_id IS NOT NULL')
      .all() as { call_id: string }[]
    const uniqueExternalIds = new Set(launched.map((row) => row.attemptId)).size
    let replayMatches: boolean | null = null
    if (outcome.state === 'completed') {
      const replay = new WorkflowExecutionService({
        store,
        slots: new WorkflowScriptSlots(3),
        reservation: 1,
        progress: () => {},
        launch: () => {
          throw new Error('Replay must not construct a process adapter')
        }
      })
      const replayed = await replay.recoverCompleted(executionId, 1)
      const afterLedger = readFileSync(ledgerPath, 'utf8').trim().split('\n').length
      replayMatches =
        JSON.stringify(replayed) === JSON.stringify(outcome) && afterLedger === launched.length
    }
    const pass =
      outcome.state === testCase.expectedState &&
      launched.length === testCase.expectedLaunches &&
      attemptRows.length === launched.length &&
      uniqueExternalIds === launched.length &&
      accepted.length === testCase.expectedAccepted &&
      (replayMatches === null || replayMatches)
    return {
      ...testCase,
      executionId,
      observedState: outcome.state,
      error: outcome.error ?? null,
      externalLaunches: launched.length,
      attemptRows: attemptRows.length,
      acceptedCalls: accepted.length,
      uniqueExternalIds,
      replayMatches,
      pass
    }
  } finally {
    db.close()
  }
}

async function main() {
  const outputRoot = process.argv[2]
  if (!outputRoot || existsSync(outputRoot)) {
    throw new Error('Provide a new disposable output directory')
  }
  mkdirSync(outputRoot)
  const sourceSha = createHash('sha256').update(readFileSync(__filename)).digest('hex')
  const rows = []
  for (const [index, testCase] of soakCases.entries()) {
    const row = await runCase(testCase, outputRoot)
    rows.push(row)
    if ((index + 1) % 10 === 0) {
      console.log(
        JSON.stringify({ completed: index + 1, failures: rows.filter((item) => !item.pass).length })
      )
    }
  }
  const report = {
    testId: 'fixture-soak-50',
    sourceSha,
    gitSha: process.env.WORKFLOW_GIT_SHA ?? 'record separately',
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    caveat:
      'Real durable service and POSIX process/receipt adapter with external synthetic native envelopes; not public RPC, provider isolation or live-model quality proof.',
    total: rows.length,
    expectedCompleted: 40,
    expectedFailed: 10,
    assertionFailures: rows.filter((row) => !row.pass).length,
    rows
  }
  const reportPath = join(outputRoot, 'report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({ reportPath, total: rows.length, assertionFailures: report.assertionFailures })
  )
  if (report.assertionFailures) {
    process.exitCode = 1
  }
}
void main()
