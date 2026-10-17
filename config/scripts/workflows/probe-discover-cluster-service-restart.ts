import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import { captureWorkflowOwner } from '../../../src/main/runtime/workflow-script/workflow-owner-claim'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import type { WorkflowProgramCall } from '../../../src/main/runtime/workflow-script/workflow-program-context'

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  discoverProgramRevision: 4,
  task: { prompt: 'Fixture question', evidence: 'Frozen fixture evidence' },
  synthesizerId: 'claude',
  discover: {
    dimensions: ['Correctness', 'Actual user path', 'Reliability / resume'],
    lenses: ['Mechanism', 'Occurrence'],
    minimumSeverity: 'medium',
    maxCandidates: 12
  },
  seats: [
    { id: 'claude', agent: 'claude', model: 'fixture-claude', lineage: 'anthropic' },
    { id: 'codex', agent: 'codex', model: 'fixture-codex', lineage: 'openai' },
    { id: 'grok', agent: 'grok', model: 'fixture-grok', lineage: 'xai' }
  ].map((seat) => ({
    ...seat,
    accountId: 'fixture',
    effort: null,
    policyRevision: 'fixture-v1'
  })) as WorkflowProgramSnapshot['seats']
}
function native(call: WorkflowProgramCall, attemptId: string): string {
  const value = call.id.startsWith('discover/')
    ? {
        findings:
          call.id === 'discover/Reliability / resume'
            ? []
            : [
                {
                  issueKey:
                    call.id === 'discover/Correctness'
                      ? 'activity-pagination-tie-skip'
                      : 'activity-cursor-skips-same-timestamp-rows',
                  title: 'Tied rows omitted',
                  location: 'src/activity.ts:1-10',
                  trigger: 'Tied timestamp reaches page boundary',
                  impact: 'Missing rows',
                  severity: 'high',
                  evidence: [
                    { ref: 'src/activity.ts:1-10', description: 'Strict timestamp filter' }
                  ]
                }
              ],
        omittedCount: 0,
        omissionReason: ''
      }
    : call.id.startsWith('cluster/')
      ? (() => {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
            candidates: { id: string }[]
          }
          return {
            groups: [
              { ids: packet.candidates.map((item) => item.id), reason: 'Same cursor mechanism' }
            ]
          }
        })()
      : call.id.startsWith('refute/')
        ? { refuted: false, uncertain: false, reason: 'Supported', evidence: [] }
        : (() => {
            const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)) as {
              survivors: { id: string }[]
            }
            return {
              summary: 'One supported root',
              ranking: packet.survivors.map((item) => ({
                findingId: item.id,
                reason: 'Supported',
                nextAction: 'Fix cursor'
              }))
            }
          })()
  if (call.seatId === 'codex') {
    return [
      { type: 'thread.started', thread_id: attemptId },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
      { type: 'turn.completed', usage: {} }
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
  }
  return JSON.stringify(
    call.seatId === 'claude'
      ? {
          type: 'result',
          subtype: 'success',
          is_error: false,
          structured_output: value,
          session_id: attemptId,
          modelUsage: { 'fixture-claude': {} },
          usage: {}
        }
      : {
          stopReason: 'end_turn',
          structuredOutput: value,
          sessionId: attemptId,
          requestId: attemptId,
          modelUsage: { 'fixture-grok': {} },
          usage: {}
        }
  )
}
async function main() {
  const [mode, directory, crashAt = 'cluster/1'] = process.argv.slice(2)
  if (!['crash', 'recover'].includes(mode) || !directory) {
    throw new Error('Expected crash|recover and existing fixture directory')
  }
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const owner = await captureWorkflowOwner('diagnostic-service-host')
  const ledger = join(directory, 'external-launch-ledger.jsonl')
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    attestNativeResult: ({ seat, parsed }) => {
      if (seat.agent !== 'codex' && !parsed.resolvedModels?.includes(seat.model)) {
        throw new Error('Recovered fixture model did not match its frozen seat')
      }
    },
    progress: (_id, event) => console.log(JSON.stringify(event)),
    launch: (_snapshot, executionId, fence) => async (input) => {
      if (
        mode === 'recover' &&
        readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .some((row) => {
            const entry = JSON.parse(row)
            return entry.event === 'spawn' && entry.callId === input.call.id
          })
      ) {
        throw new Error('Recovery tried to repeat a fixture process')
      }
      const output = native(input.call, input.attemptId)
      const launch = createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        fence,
        hostId: owner.hostId,
        ownerIncarnation: owner.spawnToken,
        timeoutMs: 5000,
        maxOutputBytes: 16 * 1024,
        command: () => ({
          program: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(output)})`],
          input: input.call.prompt
        })
      })
      const result = await launch({
        ...input,
        recordLaunch: (ref) => {
          const receipt = JSON.parse(readFileSync(ref, 'utf8'))
          appendFileSync(
            ledger,
            `${JSON.stringify({ event: 'spawn', attemptId: input.attemptId, callId: input.call.id, pid: receipt.pid })}\n`
          )
          input.recordLaunch(ref)
        }
      })
      appendFileSync(
        ledger,
        `${JSON.stringify({ event: 'exit', attemptId: input.attemptId, callId: input.call.id })}\n`
      )
      if (mode === 'crash' && input.call.id === crashAt) {
        writeFileSync(
          join(directory, 'before-crash.json'),
          JSON.stringify({ executionId, pid: process.pid, attemptId: input.attemptId, crashAt })
        )
        process.kill(process.pid, 'SIGKILL')
      }
      return result
    }
  })
  try {
    if (mode === 'crash') {
      if (store.findStart('discover-cluster-restart', 'first')) {
        throw new Error('Fixture already exists')
      }
      const id = service.start({
        conversationId: 'discover-cluster-restart',
        requestId: 'first',
        owner,
        snapshot,
        preset: 'discover',
        fence: 1,
        attemptLimit: 3,
        callLimit: 30,
        budgetLimit: 90
      })
      const unexpected = await service.wait(id)
      throw new Error(`Expected host SIGKILL; got ${JSON.stringify(unexpected)}`)
    }
    const before = JSON.parse(readFileSync(join(directory, 'before-crash.json'), 'utf8'))
    const recovered = await service.recoverInterrupted(before.executionId, 1, owner)
    if (recovered.state !== 'paused') {
      throw new Error(`Recovery failed: ${JSON.stringify(recovered)}`)
    }
    service.resume(before.executionId, recovered.fence)
    const completed = await service.wait(before.executionId)
    const entries = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row))
    if (
      completed.state !== 'completed' ||
      entries.filter((entry) => entry.event === 'spawn').length !== 8
    ) {
      throw new Error('Recovered service launched or did not complete')
    }
    const report = {
      crashAt: before.crashAt,
      previousPid: before.pid,
      pid: process.pid,
      executionId: before.executionId,
      recovered,
      completed,
      ledger: entries,
      attempts: database.db
        .prepare('SELECT call_id,ordinal,fence,state FROM local_workflow_attempts')
        .all(),
      budget: database.db
        .prepare('SELECT budget_reserved,budget_limit,fence,state FROM local_workflow_executions')
        .get(),
      scope:
        'real host SIGKILL and full service reconstruction; child providers are native-shaped Node fixtures, not inference'
    }
    writeFileSync(join(directory, 'recovery-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      JSON.stringify({
        state: completed.state,
        fence: recovered.fence,
        spawnCount: 8,
        pid: process.pid
      })
    )
  } finally {
    database.close()
  }
}
void main()
