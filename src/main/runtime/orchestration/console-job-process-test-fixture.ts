import type { PtyLaunchGateReceipt } from '../../../shared/pty-launch-gate'
import { attachConsoleJobStartReceipt, bindConsoleJobDispatch } from './console-job-binding'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from './console-job-process-handshake'
import {
  consoleJobClaimFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from './console-job-test-fixture'
import type { OrchestrationDb } from './db/orchestration-db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'

export function createConsoleJobProcessFixture(db: OrchestrationDb) {
  const binding = consoleJobClaimFixture
  const run = createConsoleJobRun(db, binding)
  const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: binding.taskId })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  const identity: ConsoleJobProcessIdentity = {
    runId: run.id,
    dispatchId: dispatch.id,
    principal: consoleJobPrincipalFixture,
    binding
  }
  bindConsoleJobDispatch(db, identity)
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: 'launch-1',
    gateId: 'gate-1',
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    pid: 42,
    processStartTimeMs: 1_780_000_000_000,
    processKind: 'pty-root',
    reportsChildExitStatus: true,
    startupCommandMode: 'exec'
  }
  return { identity, gate }
}

export function attachConsoleJobProcessStart(
  db: OrchestrationDb,
  identity: ConsoleJobProcessIdentity
) {
  return attachConsoleJobStartReceipt(db, {
    ...identity,
    binding: {
      ...identity.binding,
      sessionId: 'ses_canonical',
      attemptId: 'attempt_canonical',
      inputDigest: 'd'.repeat(64)
    }
  })
}

export function recordReleasedConsoleJobProcess(
  db: OrchestrationDb,
  identity: ConsoleJobProcessIdentity,
  gate: PtyLaunchGateReceipt
) {
  recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
  attachConsoleJobProcessStart(db, identity)
  recordConsoleJobProcessHandshake(db, identity, { phase: 'start_acknowledged', gate })
  const startAcknowledgement = readConsoleJobProcessHandshake(db, identity)!.startAcknowledgement!
  recordConsoleJobProcessHandshake(db, identity, {
    phase: 'release_intent',
    gate,
    startAcknowledgement
  })
  recordConsoleJobProcessHandshake(db, identity, {
    phase: 'released',
    gate,
    released: { gateId: gate.gateId, state: 'released', startAcknowledgement }
  })
}
