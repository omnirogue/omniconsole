import { workflowCallDigest } from '../../../src/main/runtime/workflow-script/workflow-call-digest'
import type { WorkflowProgramCall } from '../../../src/main/runtime/workflow-script/workflow-program-context'
import { captureWorkflowOwner } from '../../../src/main/runtime/workflow-script/workflow-owner-claim'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import { readWorkflowProcessReceipt } from '../../../src/main/runtime/workflow-script/workflow-process-receipt'

const seat = {
  id: 'fixture',
  agent: 'claude',
  accountId: 'fixture',
  model: 'fixture-model',
  effort: null,
  lineage: 'anthropic',
  policyRevision: 'fixture-v1'
}
const call: WorkflowProgramCall = {
  id: 'answers/fixture',
  seatId: 'fixture',
  prompt: 'fixture',
  dependencies: [],
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false
  },
  validateSemantics: (value) =>
    (value as { answer: string }).answer === 'crash-proof' ? null : 'Wrong fixture answer'
}
const inputDigest = workflowCallDigest(call, JSON.stringify(seat), seat.agent)
const nativeOutput = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output: { answer: 'crash-proof' },
  session_id: 'fixture-session',
  modelUsage: { 'fixture-model': {} },
  usage: {}
})

async function main() {
  const [mode, directory] = process.argv.slice(2)
  if (!['crash', 'read', 'claim', 'adopt'].includes(mode) || !directory) {
    throw new Error('Expected crash|read|claim|adopt <existing disposable directory>')
  }
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const ledger = join(directory, 'external-spawn-ledger')
  try {
    if (mode === 'crash') {
      if (store.findStart('crash-proof', 'first')) {
        throw new Error('Proof already exists')
      }
      const owner = await captureWorkflowOwner('diagnostic-fixture-host')
      const executionId = store.create({
        owner,
        conversationId: 'crash-proof',
        requestId: 'first',
        snapshot: {
          version: 1,
          task: { prompt: 'fixture', evidence: '' },
          seats: [seat],
          synthesizerId: seat.id
        },
        preset: 'council',
        fence: 1,
        attemptLimit: 3,
        callLimit: 7,
        budgetLimit: 1
      })
      const attempt = store.prepare({
        executionId,
        fence: 1,
        callId: 'answers/fixture',
        inputDigest,
        reservation: 1,
        validate: () => {}
      })
      if (!('attemptId' in attempt)) {
        throw new Error('Expected prepared attempt')
      }
      const args = [
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'spawn\\n'); process.stdout.write(${JSON.stringify(nativeOutput)})`
      ]
      const launch = createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        fence: 1,
        hostId: 'diagnostic-fixture-host',
        ownerIncarnation: owner.spawnToken,
        timeoutMs: 3000,
        maxOutputBytes: 1024,
        command: () => ({ program: process.execPath, args, input: call.prompt })
      })
      const result = await launch({
        ...attempt,
        problems: null,
        signal: new AbortController().signal,
        recordPreparation: (identity) =>
          store.recordProcessPreparation(attempt.attemptId, 1, identity),
        recordLaunch: (ref) => store.recordLaunch(attempt.attemptId, 1, ref),
        call
      })
      writeFileSync(
        join(directory, 'before-crash.json'),
        JSON.stringify({ pid: process.pid, executionId, attemptId: attempt.attemptId, result })
      )
      process.kill(process.pid, 'SIGKILL')
    } else {
      const before = JSON.parse(readFileSync(join(directory, 'before-crash.json'), 'utf8'))
      const identity = store.readProcessIdentity(before.attemptId, 1)
      const result = readWorkflowProcessReceipt(identity)
      let attempt = database.db
        .prepare('SELECT state, ordinal FROM local_workflow_attempts WHERE id=?')
        .get(before.attemptId)
      let calls = database.db.prepare('SELECT accepted_attempt_id FROM local_workflow_calls').all()
      const spawns = readFileSync(ledger, 'utf8')
      if (
        before.pid === process.pid ||
        JSON.stringify(before.result) !== JSON.stringify(result) ||
        spawns !== 'spawn\n'
      ) {
        throw new Error('Crash receipt reconstruction failed')
      }
      const claimedFence = ['claim', 'adopt'].includes(mode)
        ? await store.claimOwner(before.executionId, 1, await captureWorkflowOwner(identity.hostId))
        : null
      let adopted: string | null = null
      let replayed: unknown = null
      if (mode === 'adopt' && claimedFence) {
        adopted = store.recoverAttempt({ attemptId: before.attemptId, fence: claimedFence, call })
        replayed = store.prepare({
          executionId: before.executionId,
          fence: claimedFence,
          callId: call.id,
          inputDigest,
          reservation: 1,
          validate: (value) => {
            if (call.validateSemantics(value)) {
              throw new Error('Invalid cache')
            }
          }
        })
        if (
          adopted !== 'accepted' ||
          JSON.stringify(replayed) !== JSON.stringify({ cached: { answer: 'crash-proof' } }) ||
          readFileSync(ledger, 'utf8') !== spawns
        ) {
          throw new Error('Adoption or replay failed')
        }
        attempt = database.db
          .prepare('SELECT state,ordinal FROM local_workflow_attempts WHERE id=?')
          .get(before.attemptId)
        calls = database.db.prepare('SELECT accepted_attempt_id FROM local_workflow_calls').all()
      }
      const claimedState = claimedFence
        ? store.inspect(before.executionId, claimedFence).state
        : null
      const report = {
        adopted,
        replayed,
        claimedFence,
        claimedState,
        pid: process.pid,
        previousPid: before.pid,
        identity,
        result,
        attempt,
        calls,
        spawnCount: 1,
        budget: database.db
          .prepare('SELECT budget_reserved,budget_limit FROM local_workflow_executions')
          .get(),
        scope:
          'single-call native fixture reconstruction, optional owner claim and adoption; not full workflow recovery'
      }
      writeFileSync(
        join(directory, 'recovered-receipt.json'),
        `${JSON.stringify(report, null, 2)}\n`
      )
      console.log(
        JSON.stringify({
          directory,
          previousPid: before.pid,
          pid: process.pid,
          spawnCount: 1,
          attempt,
          adopted,
          claimedFence,
          claimedState
        })
      )
    }
  } finally {
    database.close()
  }
}
void main()
