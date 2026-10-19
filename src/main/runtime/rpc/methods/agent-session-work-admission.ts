import { z } from 'zod'
import type { RuntimeCreateAgentSessionRequest } from '../../../../shared/agent-session-host-authority'
import type { LaunchCause } from '../../../../shared/launch-cause'
import {
  admitAgentLaunch,
  classifyAgentLaunch,
  workContractAdmissionMode,
  type WorkAdmission,
  type WorkContractAdmissionMode
} from '../../../../shared/work-contract-admission'
import { readManagedSessionToolsFiles } from '../../managed-session-tools-files'

const MAX_WORK_CONTRACT_BYTES = 64 * 1024

/** Shape is checked by admission so refusals carry contract codes, not schema errors. */
export const WorkContractParam = z
  .unknown()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= MAX_WORK_CONTRACT_BYTES,
    'Work contract is too large'
  )

/** The host-owned descriptor exists only when the BFF already admitted this operation's contract. */
function hubAdmittedLaunch(request: RuntimeCreateAgentSessionRequest): boolean {
  if (!request.managedToolsFile) {
    return false
  }
  try {
    readManagedSessionToolsFiles(request.managedToolsFile, {
      nativeOperationId: request.clientOperationId,
      provider: request.agent
    })
    return true
  } catch {
    return false
  }
}

/** Runs before the runtime creates anything; throws a coded refusal or returns the launch's record. */
export function admitCreateAgentSession(
  request: RuntimeCreateAgentSessionRequest,
  launchCause: LaunchCause,
  mode: WorkContractAdmissionMode = workContractAdmissionMode()
): WorkAdmission {
  const verdict = admitAgentLaunch({
    classification: classifyAgentLaunch({
      params: request,
      actorKind: launchCause.actor?.kind,
      hubAdmitted: mode !== 'off' && hubAdmittedLaunch(request)
    }),
    contract: request.workContract,
    mode
  })
  if (!verdict.admitted) {
    throw Object.assign(new Error(verdict.message), {
      code: verdict.code,
      data: { workAdmission: verdict.workAdmission }
    })
  }
  return verdict.workAdmission
}
