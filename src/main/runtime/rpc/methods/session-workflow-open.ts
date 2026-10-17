import { z } from 'zod'
import {
  SESSION_WORKFLOW_NOT_FOUND_CODE,
  SESSION_WORKFLOW_OPEN_RPC,
  SESSION_WORKFLOW_UNVERIFIABLE_CODE,
  type SessionWorkflowOpenParams
} from '../../../../shared/session-workflow-records'
import { defineMethod, type RpcAnyMethod } from '../core'
import type { SessionWorkflowRecordStore } from '../../session-workflow-record-store'

type WorkflowOpenRuntime = {
  getSessionWorkflowRecordStore?: () => Pick<
    SessionWorkflowRecordStore,
    'isComplete' | 'findRecord'
  >
  revealSessionWorkflowConversation?: (worktreeId: string, tabId: string) => boolean
}

const SessionWorkflowOpenParamsSchema = z
  .object({
    worktree: z.string().trim().min(1).max(4096),
    tabId: z.string().trim().min(1).max(200)
  })
  .strict()

function workflowOpenRefusal(
  code: typeof SESSION_WORKFLOW_UNVERIFIABLE_CODE | typeof SESSION_WORKFLOW_NOT_FOUND_CODE,
  reason: string
): Error {
  const error = new Error(
    code === SESSION_WORKFLOW_NOT_FOUND_CODE
      ? 'This workflow is no longer open on the computer that runs it.'
      : 'The computer that runs this workflow cannot open it right now (its window is closed or still loading). Nothing was started; try again in a moment.'
  ) as Error & { code: string; data: { retryable: boolean; reason: string } }
  error.code = code
  error.data = { retryable: code === SESSION_WORKFLOW_UNVERIFIABLE_CODE, reason }
  return error
}

/**
 * Opens one of this computer's workflow conversations visibly in its own window, for a paired
 * computer that clicked its mirrored row (step 9). Only a conversation this runtime's window
 * published may open; nothing here creates a terminal or starts a run.
 */
export function openSessionWorkflowConversation(
  runtime: WorkflowOpenRuntime,
  params: SessionWorkflowOpenParams
): { opened: true } {
  const store = runtime.getSessionWorkflowRecordStore?.()
  if (!store?.isComplete()) {
    throw workflowOpenRefusal(SESSION_WORKFLOW_UNVERIFIABLE_CODE, 'no-complete-publication')
  }
  const worktreeId = params.worktree.startsWith('id:') ? params.worktree.slice(3) : params.worktree
  if (!store.findRecord(worktreeId, params.tabId)) {
    throw workflowOpenRefusal(SESSION_WORKFLOW_NOT_FOUND_CODE, 'not-in-publication')
  }
  if (!runtime.revealSessionWorkflowConversation?.(worktreeId, params.tabId)) {
    throw workflowOpenRefusal(SESSION_WORKFLOW_UNVERIFIABLE_CODE, 'no-window')
  }
  return { opened: true }
}

export const SESSION_WORKFLOW_OPEN_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: SESSION_WORKFLOW_OPEN_RPC,
    params: SessionWorkflowOpenParamsSchema,
    handler: async (params, { runtime }) =>
      openSessionWorkflowConversation(runtime as WorkflowOpenRuntime, params)
  })
]
