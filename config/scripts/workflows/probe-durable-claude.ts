import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import { createDurableWorkflowAgent } from '../../../src/main/runtime/workflow-script/workflow-durable-call'
import { buildWorkflowClaudeArgs } from '../../../src/shared/workflow-claude-command'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'

const diagnosticOwnerIncarnation = randomUUID()

async function main() {
  const [mode, directory] = process.argv.slice(2)
  if (!['live', 'replay'].includes(mode) || !directory) {
    throw new Error('Expected live|replay and existing disposable directory')
  }
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  const store = new WorkflowCheckpointStore(database.db)
  const controller = new AbortController()
  const model = 'claude-sonnet-5'
  const executionId = store.create({
    conversationId: 'durable-live-proof',
    requestId: 'first',
    snapshot: { model, effort: 'low', prompt: 'Return answer equal to durable-native-proof.' },
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 1
  })
  const ledger = join(directory, 'external-launch-ledger.jsonl')
  try {
    const agent = createDurableWorkflowAgent({
      store,
      executionId,
      fence: 1,
      slots: new WorkflowScriptSlots(1),
      signal: controller.signal,
      reservation: 1,
      seatFingerprint: () => 'claude-sonnet-5:low:system-explicit:isolated-v1:answer-v1',
      route: () => 'claude',
      closeAdmission: (error) => controller.abort(error),
      launch: async ({
        call,
        attemptId,
        ordinal,
        problems,
        signal,
        recordLaunch,
        recordPreparation
      }) => {
        if (mode === 'replay') {
          throw new Error('Replay attempted a new model launch')
        }
        const launch = createWorkflowLocalProcessLaunch({
          hostId: `diagnostic:${hostname()}`,
          ownerIncarnation: diagnosticOwnerIncarnation,
          directory,
          executionId,
          fence: 1,
          timeoutMs: 90_000,
          maxOutputBytes: 256 * 1024,
          command: () => ({
            program: 'claude',
            args: buildWorkflowClaudeArgs({ model, effort: 'low', attemptId, schema: call.schema }),
            cwd: directory,
            env: { ...process.env, CLAUDE_CONFIG_DIR: join(homedir(), '.claude') },
            input: call.prompt
          })
        })
        const result = await launch({
          call,
          attemptId,
          ordinal,
          problems,
          signal,
          recordPreparation,
          recordLaunch: (path) => {
            const receipt = JSON.parse(readFileSync(path, 'utf8'))
            appendFileSync(
              ledger,
              `${JSON.stringify({ attemptId, pid: receipt.pid, event: 'spawn' })}\n`
            )
            recordLaunch(path)
          }
        })
        appendFileSync(ledger, `${JSON.stringify({ attemptId, event: 'exit' })}\n`)
        return result
      }
    })
    const value = await agent({
      id: 'answers/claude',
      seatId: 'claude',
      prompt: 'Return answer equal to durable-native-proof.',
      dependencies: [],
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false
      },
      validateSemantics: (value) =>
        (value as { answer: string }).answer === 'durable-native-proof'
          ? null
          : 'Wrong proof answer'
    })
    const report = {
      mode,
      pid: process.pid,
      executionId,
      value,
      attempts: database.db.prepare('SELECT id, ordinal, state FROM local_workflow_attempts').all(),
      budget: database.db
        .prepare('SELECT budget_reserved, budget_limit FROM local_workflow_executions')
        .get(),
      ledger: readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row))
    }
    writeFileSync(
      `docs/workflows/evidence/durable-claude-adapter-${mode}.json`,
      `${JSON.stringify(report, null, 2)}\n`
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    database.close()
  }
}
void main()
