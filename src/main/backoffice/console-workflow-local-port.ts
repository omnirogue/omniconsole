import { isDeepStrictEqual } from 'node:util'
import type {
  ConsoleLocalExecutionPort,
  ConsoleLocalJob
} from '../console-workflows/console-local-execution-contract'
import type { ConsoleLocalStartRequest } from '../../shared/console-local-execution'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { consoleLocalStartRequest } from '../console-workflows/console-local-execution-schema'
import { consoleJobInputDigest } from '../console-workflows/console-job-digests'
import { getNativeLocalPtyProvider } from '../ipc/pty/provider/registry'
import {
  captureConsoleWorkflowPerson,
  getConsolePublicationPrincipal,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'
import { activateConsoleWorkflowJob, readConsoleWorkflowHandoff } from './console-workflow-handoff'
import {
  readConsoleActivationIntent,
  retainConsoleActivationIntent
} from './console-workflow-activation-intent'
import { readConsoleWorkflowClaim } from './console-workflow-claim-record'
import { startConsoleWorkflowProcess } from './console-workflow-start'
import { failure, unavailable } from './console-workflow-transport'
import { prepareConsoleTaskInputs } from './console-task-inputs'
import { publishConsoleFolderArtifact } from './console-folder-artifact'
import { hydrateConsoleWorkflowFolderCandidate } from './console-folder-input'

async function readyJob(
  request: ConsoleLocalStartRequest,
  principal: string
): Promise<ConsoleWorkflowResult<ConsoleLocalJob>> {
  if (!consoleLocalStartRequest.safeParse(request).success) {
    return failure('invalid_request', 'Select one named job and approve its exact graph digest.')
  }
  const ready = await readConsoleWorkflowHandoff(request.jobId, principal)
  if (!ready.ok) {
    return ready
  }
  const job = ready.data
  if (
    job.workflowId !== request.workflowId ||
    job.digest !== request.approvedDigest ||
    job.placement !== 'local'
  ) {
    return failure(
      'invalid_request',
      'The named local job does not match the approved workflow digest.'
    )
  }
  if (job.state === 'ready') {
    return ready
  }
  // A lost activation response may be retried only by an explicit start with its retained request.
  const intent = readConsoleActivationIntent(principal, job.id, job.digest)
  if (job.state === 'running' && intent) {
    const claimed = await readConsoleWorkflowClaim(job.id, principal)
    if (!claimed.ok) {
      return claimed
    }
    if (
      claimed.data.runner_instance === intent.runnerInstance &&
      claimed.data.claim_request_id === intent.claimRequestId &&
      !claimed.data.cancel_requested &&
      !claimed.data.process_identity &&
      !claimed.data.terminal_proof
    ) {
      return { ok: true, data: { ...job, state: 'ready' } }
    }
  }
  return failure('not_ready', 'The named job is not ready for an explicit local start.')
}

/** Person-scoped operations only; construction and restore never activate a job. */
export function createConsoleWorkflowLocalPort(): ConsoleLocalExecutionPort {
  const read = async (request: ConsoleLocalStartRequest) => {
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    if (getNativeLocalPtyProvider().supportsLaunchGateObservation?.() !== true) {
      return failure<ConsoleLocalJob>(
        'capability_unavailable',
        'This execution host cannot yet verify the held process birth and exit.'
      )
    }
    return readyJob(request, person.data.principal)
  }
  return {
    captureLaunchAuthority: async () => {
      const person = await captureConsoleWorkflowPerson()
      return person.ok
        ? { principal: person.data.principal, isCurrent: person.data.isCurrent }
        : null
    },
    prepareInputs: prepareConsoleTaskInputs,
    hydrateFolderCandidate: hydrateConsoleWorkflowFolderCandidate,
    publishFolderArtifact: publishConsoleFolderArtifact,
    getReadyJob: read,
    activate: async (request) => {
      const person = await captureConsoleWorkflowPerson()
      if (!person.ok) {
        return person
      }
      const ready = await read(request)
      if (!ready.ok) {
        return ready
      }
      if (!person.data.isCurrent()) {
        return failure('principal_mismatch', 'The signed-in person changed before activation.')
      }
      const intent = retainConsoleActivationIntent(
        person.data.principal,
        ready.data.id,
        ready.data.digest
      )
      return activateConsoleWorkflowJob({
        job: ready.data,
        principal: person.data.principal,
        ...intent
      })
    },
    startProcess: async (input) => {
      const current = await readConsoleWorkflowHandoff(input.binding.jobId, input.principal)
      if (!current.ok) {
        return current
      }
      if (
        current.data.state !== 'running' ||
        !isDeepStrictEqual(current.data, { ...input.job, state: current.data.state }) ||
        (input.job.baseSha !== undefined && input.job.baseSha !== input.baseSha) ||
        consoleJobInputDigest(input.binding, input.job, input.baseSha) !== input.inputDigest
      ) {
        return failure(
          'invalid_request',
          'The process start no longer matches the frozen executable handoff.'
        )
      }
      return startConsoleWorkflowProcess({
        ...input,
        ...(input.job.workspace ? { workspace: input.job.workspace } : {})
      })
    },
    inspect: async (binding, principal) => {
      const claim = await readConsoleWorkflowClaim(binding.jobId, principal, binding)
      return claim.ok ? { ok: true, data: { cancelled: claim.data.cancel_requested } } : claim
    },
    result: () => unavailable('result publication without its committed journal cursor'),
    cancelled: () =>
      unavailable(
        'an unfenced cancellation mutation; use the bound Dispatch stop and terminal result'
      ),
    principal: getConsolePublicationPrincipal,
    sanitize: sanitizeConsoleWorkflowText
  }
}
