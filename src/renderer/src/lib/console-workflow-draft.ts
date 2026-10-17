import type {
  ConsoleWorkflowActor,
  ConsoleWorkflowAction,
  ConsoleWorkflowPreview
} from '../../../shared/console-workflow-types'
import { isSequentialConsoleWorkflow } from '../../../shared/console-workflow-task-admission-schemas'
import {
  newWorkflowAdmissionDraft,
  type WorkflowAdmissionDraft
} from './console-workflow-admission-draft'
import type { WorkflowAcceptanceDraft } from './console-workflow-draft-acceptance'

export type WorkflowDraftStage = {
  key: string
  title: string
  actorType: ConsoleWorkflowActor
  actorId: string
  action: ConsoleWorkflowAction
  provider: string
  model: string
  effort: string
  prompt: string
  placement: 'inherit' | 'local' | 'fleet'
  after: string[]
  inputs: string
  acceptance: string
  acceptanceCommands: WorkflowAcceptanceDraft[]
}

export type WorkflowDraft = {
  taskId: string
  title: string
  company: string
  repo: string
  prompt: string
  placement: 'local' | 'fleet'
  stages: WorkflowDraftStage[]
  admission: WorkflowAdmissionDraft
}

export function newWorkflowDraft(taskId = ''): WorkflowDraft {
  return {
    taskId,
    title: '',
    company: '',
    repo: '',
    prompt: '',
    placement: 'local',
    stages: [newWorkflowStage('stage-1')],
    admission: newWorkflowAdmissionDraft()
  }
}

export function newWorkflowStage(key: string, after: string[] = []): WorkflowDraftStage {
  return {
    key,
    title: '',
    actorType: 'ai',
    actorId: '',
    action: 'execute',
    provider: 'codex',
    model: '',
    effort: '',
    prompt: '',
    placement: 'inherit',
    after,
    inputs: '',
    acceptance: '',
    acceptanceCommands: []
  }
}

export function sequentialWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
  return {
    ...draft,
    stages: draft.stages.map((stage, index) => ({
      ...stage,
      after: index ? [draft.stages[index - 1].key] : []
    }))
  }
}

export function requireSequentialWorkflowPreview(preview: ConsoleWorkflowPreview): void {
  if (!isSequentialConsoleWorkflow(preview.graph)) {
    throw new Error(
      'This release supports sequential workflow stages. Request a sequential preview.'
    )
  }
}

export function workflowDraftFingerprint(draft: WorkflowDraft): string {
  return JSON.stringify(draft)
}
