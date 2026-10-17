import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { consoleJobActivationReceipt } from '../runtime/orchestration/console-job-activation-receipt'
import { admitOrchestrationRun, type AdmittedRun } from '../runtime/orchestration/run-admission'
import type { ConsoleLocalActivation } from './console-local-execution-contract'

/**
 * Install a console job binding on a fresh Run.
 *
 * Why this is not an RPC method: the binding and its publication principal are
 * the admission evidence the execution fence reads. Accepting them as request
 * parameters -- as `orchestration.runCreate` once did -- let any caller holding
 * a card id fabricate a structurally valid binding, take
 * `origin = 'hub_dispatched'` and start a local worker through the console
 * carve-out with no Hub start receipt at all. This function is reachable only
 * from the main process activation path that already holds the server's
 * response, and it re-checks the signed-in person here, at the moment the
 * evidence is written, rather than trusting the principal that was handed to it.
 */
export async function admitConsoleJobRun(args: {
  runtime: OrcaRuntimeService
  activation: ConsoleLocalActivation
  coordinatorHandle: string
  objective: string
  /** The live signed-in person's computed principal (`captureConsoleWorkflowPerson`). */
  livePrincipal: () => Promise<string | null>
}): Promise<AdmittedRun> {
  const { binding, principal, job } = args.activation
  const live = await args.livePrincipal()
  if (!live || live !== principal) {
    throw new Error(
      'The signed-in person does not match this activation; the console job was not admitted.'
    )
  }
  if (binding.taskId !== job.taskId || binding.jobId !== job.id) {
    throw new Error('The console job binding does not describe the activated job.')
  }
  return admitOrchestrationRun({
    runtime: args.runtime,
    objective: args.objective,
    callerTerminalHandle: args.coordinatorHandle,
    hubTaskId: binding.taskId,
    consoleJob: {
      binding,
      principal,
      activation: consoleJobActivationReceipt(binding, job.digest)
    }
  })
}
