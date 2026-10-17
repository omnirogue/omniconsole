import type { LocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import {
  WORKFLOW_CONTEXT_MAX_SOURCES,
  workflowContextSourceValid
} from '../../../shared/workflow-context-sources'
import { workflowContextRequest } from '../../../shared/workflow-context-start'
import type { WorkflowContextMaterialized } from './context/context-folder'
import type { LocalWorkflowWorkspace } from './local-workflow-host-options'

export type WorkflowContextAdmission = NonNullable<ReturnType<typeof workflowContextRequest>>

export type WorkflowContextMaterializer = (input: {
  workspacePath: string
  sources: WorkflowContextAdmission['sources']
  includeWorkspace: boolean
}) => Promise<WorkflowContextMaterialized>

/**
 * What a Start asks agents to read, and why it cannot run as asked. A check runs in the real
 * workspace, so it needs that workspace as the one folder agents read; chosen sources are copied
 * on this computer, so the workspace must run here too.
 */
export function admitWorkflowContext(input: {
  draft: LocalWorkflowDraft
  workspace: LocalWorkflowWorkspace
  hasCheck: boolean
}): { context?: WorkflowContextAdmission; problems: string[] } {
  const { draft, hasCheck } = input
  const context = workflowContextRequest(draft)
  const problems: string[] = []
  if (hasCheck && draft.access === 'frozen') {
    problems.push(
      'The check runs in this workspace: choose "Find it from my description" to use a check.'
    )
  }
  if (!context) {
    return { problems }
  }
  const chosen = draft.contextSources ?? []
  if (chosen.length > WORKFLOW_CONTEXT_MAX_SOURCES || !chosen.every(workflowContextSourceValid)) {
    problems.push('A chosen file, folder or repo is not valid. Remove it and choose it again.')
  }
  if (!context.sources.length && !context.includeWorkspace) {
    problems.push('Choose at least one file, folder or repo for the agents to read.')
  }
  if (hasCheck) {
    problems.push(
      context.includeWorkspace
        ? 'The check runs in this workspace itself: remove the chosen files, folders and repos to use a check.'
        : 'The check runs in this workspace: include this workspace to use a check.'
    )
  }
  if (input.workspace.executionHost !== 'local') {
    problems.push('Chosen files, folders and repos need a workspace that runs on this computer.')
  }
  return { context, problems }
}
