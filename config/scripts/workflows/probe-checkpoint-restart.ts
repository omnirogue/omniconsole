import { readFileSync, writeFileSync } from 'node:fs'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'

const [mode, path] = process.argv.slice(2)
if (!path) {
  throw new Error('Database path required')
}
const database = new OrchestrationDb(path)
const store = new WorkflowCheckpointStore(database.db)
try {
  const executionId = store.create({
    conversationId: 'restart-fixture',
    requestId: 'start',
    snapshot: { prompt: 'immutable' },
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 1
  })
  const input = {
    executionId,
    fence: 1,
    callId: 'answers/a',
    inputDigest: 'frozen-input',
    reservation: 1,
    validate: (value: unknown) => {
      if (value !== 'accepted') {
        throw new Error('invalid cached result')
      }
    }
  }
  if (mode === 'prepare') {
    const prepared = store.prepare(input)
    if (!('attemptId' in prepared)) {
      throw new Error('Expected first attempt')
    }
    writeFileSync(`${path}.attempt.json`, JSON.stringify(prepared))
    console.log(JSON.stringify({ pid: process.pid, mode, prepared }))
  } else if (mode === 'accept') {
    let blocked = false
    try {
      store.prepare(input)
    } catch (error) {
      blocked = String(error).includes('reconciliation')
    }
    if (!blocked) {
      throw new Error('Blind relaunch was not blocked')
    }
    const { attemptId } = JSON.parse(readFileSync(`${path}.attempt.json`, 'utf8'))
    store.recordLaunch(attemptId, 1, 'fixture-process-receipt')
    const accepted = store.accept(
      attemptId,
      1,
      'accepted',
      { attemptId, processReceiptRef: 'fixture-process-receipt', liveness: 'exited' },
      input.validate
    )
    console.log(JSON.stringify({ pid: process.pid, mode, blocked, accepted }))
  } else if (mode === 'replay') {
    const cached = store.prepare(input)
    if (!('cached' in cached) || cached.cached !== 'accepted') {
      throw new Error('Cache not restored')
    }
    const counts = database.db
      .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts')
      .get()
    console.log(JSON.stringify({ pid: process.pid, mode, cached, counts }))
  } else {
    throw new Error('Unknown probe mode')
  }
} finally {
  database.close()
}
