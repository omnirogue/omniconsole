import { randomUUID } from 'node:crypto'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { SESSION_MANAGE_EVIDENCE_METHODS } from '../../shared/session-manage-types'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: readOrchestrationCompatibilityEvidence(env)
  }
}

/**
 * Workflow Starts carry it too: an agent may start one only for a person who asked
 * (shared/workflow-agent-launch.ts), and this evidence is how the host tells an agent caller.
 */
const WORKFLOW_LAUNCH_EVIDENCE_METHODS = new Set([
  'localWorkflow.run',
  'localWorkflow.start',
  'buildReview.start',
  'evolve.start'
])

/** Launch claims remain evidence; the execution host owns caller attestation. */
export function runtimeCompatibilityEnvelope(
  method: string,
  inherited: RuntimeOrchestrationEnvelope,
  options?: RuntimeOrchestrationEnvelope,
  requestId?: string
): RuntimeOrchestrationEnvelope {
  const evidence =
    options?.orchestrationCompatibilityEvidence ?? inherited.orchestrationCompatibilityEvidence
  if (method === 'terminal.createAgentSession' && !evidence) {
    return {}
  }
  if (
    method !== 'terminal.createAgentSession' &&
    !method.startsWith('orchestration.') &&
    method !== 'sessionChain.outcomeSource' &&
    method !== 'sessionChain.attachOutcome' &&
    method !== 'sessionChain.commitOutcomes' &&
    method !== 'sessionChain.sourceWaitChoice' &&
    method !== 'sessionChain.waitAsk' &&
    !SESSION_MANAGE_EVIDENCE_METHODS.has(method) &&
    !WORKFLOW_LAUNCH_EVIDENCE_METHODS.has(method)
  ) {
    return {}
  }
  return {
    ...inherited,
    compatibilityInvocationId:
      requestId ?? options?.compatibilityInvocationId ?? inherited.compatibilityInvocationId,
    orchestrationCompatibilityEvidence: evidence
  }
}
