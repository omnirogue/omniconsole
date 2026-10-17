import { assertLocalOmpRoute } from '../omp/omp-route-preflight'
import {
  captureOutcomeCurrentInputs,
  captureOutcomeSourceInputs
} from './console-outcome-current-inputs'
import { createSessionOutcomeCancellationPort } from './session-outcome-workflow-cancellation'
import { readSessionOutcomeWorkflowResult } from './session-outcome-workflow-result'
import type { SessionOutcomeWorkflowPort } from '../runtime/session-outcome-workflow-port'
import { admitRequest } from '../../shared/console-workflow-schemas'
import { sessionOutcomeWorkflowPreview } from '../../shared/session-outcome-workflow'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { resolveWorkspace } from './console-task-continuation'
import { requestConsoleWorkflow } from './console-workflow-transport'
import { workflowAdmission, workflowProgress } from './console-workflow-responses'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'

export const sessionOutcomeWorkflowAdapter: SessionOutcomeWorkflowPort = {
  cancellation: createSessionOutcomeCancellationPort,
  captureCurrentInputs: captureOutcomeCurrentInputs,
  captureSourceInputs: captureOutcomeSourceInputs,
  async preview(runtime, input) {
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok || person.data.principal !== input.principal) {
      throw new Error('Restore the signed person before reviewing this task plan.')
    }
    for (const stage of input.stages) {
      if (stage.actor?.startsWith('omp:')) {
        await assertLocalOmpRoute(runtime, input.worktree, {
          model: stage.actor.slice(4),
          openrouterCandidates: stage.openrouter_candidates
        })
      }
      for (const actor of stage.loop?.participants ?? []) {
        if (actor.startsWith('omp:')) {
          await assertLocalOmpRoute(runtime, input.worktree, {
            model: actor.slice(4)
          })
        }
      }
    }
    const workspace = await resolveWorkspace(runtime, input.worktree)
    for (const source of input.currentInputs ?? []) {
      if (workspace.kind === 'folder' && source.git) {
        throw new Error(
          'This source is a Git snapshot. Run it from the attached repo worktree it came from (the folder’s Source Control shows it), not the folder.'
        )
      }
      if (workspace.kind === 'git' && source.git?.head_sha !== workspace.base_sha) {
        throw new Error('The selected workspace no longer matches the completed source snapshot.')
      }
    }
    if (
      workspace.kind === 'folder' &&
      input.stages.some(
        (stage) =>
          stage.loop &&
          !input.currentInputs?.some(
            (source) => source.stage_key === stage.key && source.mode === 'review-source'
          )
      )
    ) {
      throw new Error(
        'Folder review requires explicitly captured current files in a separate one-round review stage; produced or repaired output must be captured after it finishes.'
      )
    }
    const response = await requestConsoleWorkflow(
      `/api/gtd/workflow-tasks/${input.taskId}/outcome-plan`,
      'POST',
      sessionOutcomeWorkflowPreview,
      {
        operation_id: input.operationId,
        workspace,
        stages: input.stages,
        ...(input.currentInputs?.length ? { current_inputs: input.currentInputs } : {}),
        ...(input.predecessorReceipts?.length
          ? { predecessor_receipts: input.predecessorReceipts }
          : {})
      },
      30_000,
      true,
      input.principal
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    if (
      !person.data.isCurrent() ||
      JSON.stringify(workspace) !== JSON.stringify(await resolveWorkspace(runtime, input.worktree))
    ) {
      throw new Error('The signed person or selected workspace changed during plan review.')
    }
    if (response.data.admission.filing_root_task_id !== input.taskId) {
      throw new Error('The preview changed the original task.')
    }
    return response.data
  },
  admit(preview, principal) {
    const admission = preview.admission
    return requestConsoleWorkflow(
      '/api/gtd/workflow-graphs/admit',
      'POST',
      workflowAdmission,
      admitRequest.parse({
        graph: preview.graph,
        digest: preview.digest,
        filing_root_task_id: admission.filing_root_task_id,
        filing_root_expected_revision: admission.filing_root_expected_revision,
        objective: admission.objective,
        org_unit_id: admission.org_unit_id,
        expected_authority_epoch: admission.expected_authority_epoch
      }),
      30_000,
      true,
      principal
    )
  },
  observe(workflowId, principal) {
    return requestConsoleWorkflow(
      `/api/gtd/workflow-graphs/${workflowId}`,
      'GET',
      workflowProgress,
      undefined,
      15_000,
      true,
      principal
    )
  },
  start(runtime, request) {
    return getConsoleLocalExecution(runtime).start(request)
  },
  receipt: readSessionOutcomeWorkflowResult,
  list(runtime) {
    return getConsoleLocalExecution(runtime).list()
  }
}
