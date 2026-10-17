import { drainWorkflowControl } from './workflow-checkpoint-controls'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  isAgentSessionProcessIdentity,
  type AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import { isProvenDeadProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  probeAgentSessionProcessIdentity,
  readProcessStartTimeMs
} from '../agent-session-process-identity-probe'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

const ownerIncarnation = randomUUID()
let processStart: Promise<number | null> | undefined

/** hostId must be the local runtime's persisted identity, never a renderer assertion. */
export async function captureWorkflowOwner(hostId: string): Promise<AgentSessionProcessIdentity> {
  const owner = {
    hostId,
    pid: process.pid,
    processStartTimeMs: await (processStart ??= readProcessStartTimeMs(process.pid)),
    spawnToken: ownerIncarnation
  }
  if (!isAgentSessionProcessIdentity(owner)) {
    throw new Error('Invalid workflow owner identity')
  }
  return owner
}

/** Reuses the existing PID-reuse-safe probe. Expiry and terminal receipts grant no ownership. */
export async function claimWorkflowOwner(input: {
  db: Database.Database
  transaction: <T>(work: () => T) => T
  executionId: string
  expectedFence: number
  owner: AgentSessionProcessIdentity
  probe?: typeof probeAgentSessionProcessIdentity
}): Promise<number> {
  const { db, owner, executionId, expectedFence } = input
  if (
    !isAgentSessionProcessIdentity(owner) ||
    owner.pid !== process.pid ||
    !Number.isSafeInteger(expectedFence) ||
    expectedFence < 1 ||
    expectedFence >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('Invalid workflow ownership claim')
  }
  const captured = await captureWorkflowOwner(owner.hostId)
  if (
    owner.spawnToken !== captured.spawnToken ||
    owner.processStartTimeMs !== captured.processStartTimeMs
  ) {
    throw new Error('Workflow claim does not identify this owner incarnation')
  }
  const prior = db
    .prepare('SELECT owner_json,owner_digest FROM local_workflow_owners WHERE execution_id=?')
    .get(executionId) as { owner_json: string; owner_digest: string } | undefined
  if (!prior || workflowEvidenceDigest(prior.owner_json) !== prior.owner_digest) {
    throw new Error('Workflow owner evidence missing or corrupt')
  }
  const previous = JSON.parse(prior.owner_json) as AgentSessionProcessIdentity
  if (!isAgentSessionProcessIdentity(previous) || previous.hostId !== owner.hostId) {
    throw new Error('Workflow owner belongs to another or unknown host')
  }
  const nextJson = JSON.stringify(owner)
  const sameOwner = prior.owner_json === nextJson
  if (
    !sameOwner &&
    !isProvenDeadProbe(
      await (input.probe ?? probeAgentSessionProcessIdentity)({ identity: previous })
    )
  ) {
    throw new Error('Previous workflow owner is live or unverifiable')
  }
  return input.transaction(() => {
    const current = db
      .prepare(
        'SELECT fence,state,snapshot_json,snapshot_digest FROM local_workflow_executions WHERE id=?'
      )
      .get(executionId) as
      | { fence: number; state: string; snapshot_json: string; snapshot_digest: string }
      | undefined
    const currentOwner = db
      .prepare('SELECT owner_json,owner_digest FROM local_workflow_owners WHERE execution_id=?')
      .get(executionId) as typeof prior
    if (
      !current ||
      current.fence !== expectedFence ||
      currentOwner?.owner_json !== prior.owner_json ||
      currentOwner?.owner_digest !== prior.owner_digest ||
      workflowEvidenceDigest(current.snapshot_json) !== current.snapshot_digest
    ) {
      throw new Error('Workflow owner changed while probing')
    }
    if (['completed', 'cancelled', 'recovery_failed'].includes(current.state)) {
      throw new Error('Workflow cannot change owner in its current state')
    }
    if (sameOwner) {
      return expectedFence
    }
    const nextFence = expectedFence + 1
    const state =
      current.state === 'failed' ? 'failed' : current.state === 'stopping' ? 'stopping' : 'pausing'
    db.prepare(
      'UPDATE local_workflow_executions SET fence=?,state=?,sequence=sequence+1 WHERE id=?'
    ).run(nextFence, state, executionId)
    db.prepare(
      'UPDATE local_workflow_owners SET owner_json=?,owner_digest=? WHERE execution_id=?'
    ).run(nextJson, workflowEvidenceDigest(nextJson), executionId)
    drainWorkflowControl(db, executionId, state)
    return nextFence
  })
}
