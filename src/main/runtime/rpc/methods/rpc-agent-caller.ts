import {
  workflowAgentLaunchRefusal,
  type WorkflowAgentLaunchFields
} from '../../../../shared/workflow-agent-launch'
import type { RpcContext } from '../core'

type CallerContext = Pick<
  RpcContext,
  'orchestrationCapability' | 'orchestrationCompatibilityEvidence'
>

/**
 * A CLI running inside an agent session: it carries a Dispatch capability or the session's
 * compatibility evidence (ORCA_AGENT_SESSION_ID, ORCA_TERMINAL_HANDLE, …). The desktop renderer
 * and a plain terminal carry neither.
 */
export function isAgentRpcCaller(context: CallerContext): boolean {
  return !!(context.orchestrationCapability || context.orchestrationCompatibilityEvidence)
}

/** Why this caller may not start `kind`: only an agent caller is held to a person's request. */
export function agentWorkflowLaunchRefusal(
  context: CallerContext,
  kind: string,
  fields: WorkflowAgentLaunchFields
): string | undefined {
  return isAgentRpcCaller(context) ? workflowAgentLaunchRefusal(kind, fields) : undefined
}

/** Workflows run on this desktop runtime: a paired device or a phone never drives one. */
export function assertLocalWorkflowCaller(
  context: Pick<RpcContext, 'pairedDeviceId' | 'clientKind'>
): void {
  if (context.pairedDeviceId || context.clientKind === 'mobile') {
    throw new Error('Council and Discover require this desktop runtime.')
  }
}

/** Throws the refusal for an agent caller that may not start `kind`. */
export function assertAgentWorkflowLaunch(
  context: CallerContext,
  kind: string,
  fields: WorkflowAgentLaunchFields
): void {
  const refusal = agentWorkflowLaunchRefusal(context, kind, fields)
  if (refusal) {
    throw new Error(refusal)
  }
}
