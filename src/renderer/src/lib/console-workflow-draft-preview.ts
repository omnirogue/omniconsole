import type { ConsoleTaskPreviewRequest } from '../../../shared/console-workflow-task-types'
import type { WorkflowDraft } from './console-workflow-draft'
import { workflowAcceptanceCommands } from './console-workflow-draft-acceptance'

export function workflowDraftPreview(
  draft: WorkflowDraft,
  revision: number
): ConsoleTaskPreviewRequest {
  return {
    taskId: draft.taskId,
    expectedRevision: revision,
    placement: draft.placement,
    prompt: draft.prompt,
    classification: {
      title: draft.title,
      company_slug: draft.company,
      ...(draft.repo.trim() ? { repo: draft.repo.trim() } : {}),
      execution_mode: 'sequential',
      steps: draft.stages.map((stage) => ({
        key: stage.key,
        title: stage.title,
        actor_type: stage.actorType,
        actor_id:
          stage.actorType === 'ai'
            ? [stage.provider, stage.model].filter(Boolean).join(':')
            : stage.actorId,
        action: stage.action,
        ...(stage.actorType === 'ai'
          ? {
              ...(stage.effort ? { effort: stage.effort } : {}),
              acceptance_commands: workflowAcceptanceCommands(stage.acceptanceCommands),
              placement: stage.placement === 'inherit' ? draft.placement : stage.placement
            }
          : {}),
        prompt: stage.prompt,
        brief: stage.prompt,
        ...(stage.acceptance.trim() ? { acceptance: stage.acceptance } : {}),
        after: stage.after,
        files: stage.inputs
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean)
      }))
    }
  }
}
