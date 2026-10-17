import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createDurableWorkflowAgent, type WorkflowAttemptLaunch } from './workflow-durable-call'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowProgramCall } from './workflow-program-context'
import { graphListSchema, graphItemsProblem } from './graph/graph-items'
import { workflowPartialItems } from './workflow-partial-items'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
const item = {
  title: 'Lost writes',
  detail: 'The final write is discarded on timeout.',
  location: 'a.ts:12',
  severity: 'high'
}
const call: WorkflowProgramCall = {
  id: 'find/a0',
  seatId: 'a',
  dependencies: [],
  prompt: 'Find defects',
  schema: graphListSchema(5),
  validateSemantics: graphItemsProblem,
  timeoutMs: 10000
}
function fixture(launch: WorkflowAttemptLaunch) {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: {},
    preset: 'discover',
    fence: 1,
    attemptLimit: 3,
    callLimit: 10,
    budgetLimit: 10
  })
  const seatFailures = new Map<string, string>()
  const agent = () =>
    createDurableWorkflowAgent({
      store,
      executionId,
      fence: 1,
      slots: new WorkflowScriptSlots(1),
      signal: new AbortController().signal,
      seatFingerprint: () => 'frozen',
      route: () => 'claude',
      reservation: 1,
      launch,
      seatFailures,
      closeAdmission: () => {}
    })
  return { agent, db }
}

describe('timeout and seat failure state', () => {
  it('retains complete partial items and continues on half the timeout budget', async () => {
    const seen: WorkflowProgramCall[] = []
    const f = fixture(async (input) => {
      seen.push(input.call)
      input.recordLaunch(input.attemptId)
      return {
        receipt: {
          attemptId: input.attemptId,
          processReceiptRef: input.attemptId,
          liveness: 'exited'
        },
        result:
          seen.length === 1
            ? {
                code: null,
                signal: 'SIGTERM',
                timedOut: true,
                stderr: '',
                stdout: JSON.stringify({
                  type: 'assistant',
                  message: {
                    content: [
                      {
                        type: 'text',
                        text: `{"items":[${JSON.stringify(item)},{"title":"truncated`
                      }
                    ]
                  }
                })
              }
            : {
                code: 0,
                signal: null,
                timedOut: false,
                stderr: '',
                stdout: JSON.stringify({
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  session_id: input.attemptId,
                  modelUsage: { 'claude-model': {} },
                  usage: {},
                  structured_output: { items: [item] }
                })
              }
      }
    })
    expect(await f.agent()(call)).toEqual({ items: [item] })
    expect(seen.map((entry) => entry.timeoutMs)).toEqual([10000, 5000])
    expect(seen[1].prompt).toContain(JSON.stringify(item))
    const row = f.db.db
      .prepare('SELECT receipt_json FROM local_workflow_attempts WHERE ordinal=1')
      .get() as { receipt_json: string }
    expect(JSON.parse(row.receipt_json)).toMatchObject({ partialItems: [item] })
  })

  it('shares an account limit across separately created call agents', async () => {
    const launch = vi.fn<WorkflowAttemptLaunch>(async (input) => {
      input.recordLaunch(input.attemptId)
      return {
        receipt: {
          attemptId: input.attemptId,
          processReceiptRef: input.attemptId,
          liveness: 'exited'
        },
        result: {
          code: 1,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: "You've hit your usage limit"
        }
      }
    })
    const f = fixture(launch)
    await expect(f.agent()(call)).rejects.toThrow('usage limit')
    await expect(f.agent()({ ...call, id: 'find/a1' })).rejects.toThrow('usage limit')
    expect(launch).toHaveBeenCalledTimes(1)
    const rows = f.db.db
      .prepare('SELECT state,receipt_json FROM local_workflow_attempts ORDER BY call_id')
      .all() as { state: string; receipt_json: string }[]
    expect(rows.every((row) => row.state === 'failed')).toBe(true)
    expect(JSON.parse(rows[1].receipt_json).noLaunch).toBe(true)
  })

  it('retains streamed complete rows and excludes unfinished or invalid rows', () => {
    const text = `{"items":[${JSON.stringify(item)},{"title":"unfinished`
    const stdout = [text.slice(0, 50), text.slice(50)]
      .map((chunk) =>
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: chunk }
          }
        })
      )
      .join('\n')
    expect(workflowPartialItems(stdout, call)).toEqual([item])
    expect(
      workflowPartialItems(
        JSON.stringify({ type: 'result', structured_output: { items: [{ title: 'bad' }] } }),
        call
      )
    ).toEqual([])
  })
})
