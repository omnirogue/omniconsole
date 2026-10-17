import { join } from 'node:path'
import { GraphJevStore, graphExecutionFolder } from '../graph/graph-jev-store'
import { workflowEvidenceDigest } from '../workflow-evidence-digest'
import { createAuditEvidenceReader } from './audit-source-store'
import {
  observeAuditJudgements,
  type AuditJudgementOptions,
  type AuditJudgementObservation,
  type AuditJudgementRequest
} from './audit-judgements'
import { AUDIT_JUDGEMENT_VERSION, AUDIT_THRESHOLD_VERSION } from './audit-judgement-contract'
import type { AuditSnapshot } from './audit-snapshot'
import type { WorkflowProgramContext } from '../workflow-program-context'
import type { WorkflowProgramSnapshot } from '../workflow-program-snapshot'
import { validateAuditSnapshot } from './audit-snapshot'
import { runAuditProgram, type AuditProgramPorts } from './audit-program'
import { assertAuditJudgementObservation } from './audit-cache-validation'
import { WorkflowCacheMissError } from '../workflow-cache-miss'
import { readAuditCacheRecord } from './audit-cache-record'
export type { AuditProgramPorts } from './audit-program'

export function createAuditJudgementObserver(
  store: GraphJevStore,
  cacheOnly: boolean,
  options: Omit<AuditJudgementOptions, 'record'> = {}
) {
  return async (input: AuditJudgementRequest): Promise<AuditJudgementObservation> => {
    const digest = workflowEvidenceDigest(
      JSON.stringify({
        input,
        question: AUDIT_JUDGEMENT_VERSION,
        threshold: AUDIT_THRESHOLD_VERSION
      })
    )
    const cached = readAuditCacheRecord(store, input.callId, digest)
    if (cached) {
      return assertAuditJudgementObservation(cached.value, input)
    }
    if (cacheOnly) {
      throw new WorkflowCacheMissError(input.callId)
    }
    return observeAuditJudgements(input, {
      ...options,
      record: (observation) => {
        assertAuditJudgementObservation(observation, input)
        store.write(input.callId, { digest, outcome: { value: observation }, at: Date.now() })
      }
    })
  }
}

export function auditReplayPortsForExecution(
  audit: AuditSnapshot,
  executionId: string,
  missing: Set<string>,
  errors: string[]
): AuditProgramPorts {
  const ports = auditPortsForExecution(audit, executionId, true)
  async function replay<T>(id: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error) {
      if (error instanceof WorkflowCacheMissError) {
        missing.add(id)
      } else {
        errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
  }
  return {
    checkEvidence: (citations) => replay('audit/evidence', () => ports.checkEvidence(citations)),
    observeJudgements: (input) => replay(input.callId, () => ports.observeJudgements(input))
  }
}

export function runAuditPreset(
  context: WorkflowProgramContext,
  preset: string,
  snapshot: WorkflowProgramSnapshot,
  ports: { audit?: AuditProgramPorts; jev?: { executionId: string; cacheOnly?: boolean } }
) {
  if (
    preset !== 'discover' ||
    snapshot.graphProgramRevision !== undefined ||
    snapshot.capability?.mode === 'working-agent'
  ) {
    throw new Error('Audit requires its own frozen analysis snapshot')
  }
  const audit = snapshot.audit!
  validateAuditSnapshot(audit, snapshot.seats)
  const host =
    ports.audit ??
    (ports.jev
      ? auditPortsForExecution(audit, ports.jev.executionId, !!ports.jev.cacheOnly)
      : undefined)
  if (!host) {
    throw new Error('Audit requires execution-host evidence and judgement ports')
  }
  return runAuditProgram(context, audit, snapshot.task.prompt, host)
}

/** Trusted hosts may supply corpus-specific redaction; absent that, no text leaves for JEV. */
export function auditPortsForExecution(
  audit: AuditSnapshot,
  executionId: string,
  cacheOnly: boolean,
  options: { root?: string; judgements?: Omit<AuditJudgementOptions, 'record'> } = {}
) {
  const folder = graphExecutionFolder(executionId, options.root)
  return {
    checkEvidence: createAuditEvidenceReader(
      audit,
      new GraphJevStore(join(folder, 'audit-evidence.json'), true),
      cacheOnly
    ),
    observeJudgements: createAuditJudgementObserver(
      new GraphJevStore(join(folder, 'audit-judgements.json'), true),
      cacheOnly,
      options.judgements
    )
  }
}
