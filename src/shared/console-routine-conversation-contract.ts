import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'

// Mirrors BOARD_TASK_ID in the Console BFF work_actions.py.
export const boardTaskId = z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/)
export const teamRoutineRun = z
  .object({
    id: z.string().optional(),
    run_id: z.string().nullish(),
    routine_id: z.string().optional(),
    iteration: z.number().optional(),
    gate_passed: z.boolean().nullish(),
    accepted: z.boolean().nullish(),
    cost_usd: z.number().nullish(),
    stop_reason: z.string().nullish(),
    notes: z.string().nullish(),
    started_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    created_at: z.string().nullish(),
    outcome_class: z.string().nullish(),
    board_task_id: boardTaskId.nullish(),
    session_id: z.string().nullish(),
    result_text: z.string().nullish(),
    result_json: z.unknown().optional(),
    session_ref: z.string().nullish()
  })
  .passthrough()
export const teamRoutineRuns = z.array(teamRoutineRun)
export const boardConversationRequest = z.object({ taskId: boardTaskId }).strict()
export const boardConversationTurn = z
  .object({
    id: z.string().optional(),
    role: z.string().optional(),
    text: z.string().nullish(),
    content: z.string().nullish(),
    created_at: z.string().nullish(),
    delivery_status: z.unknown().optional()
  })
  .passthrough()
const refusalFields = {
  reason: z.string().optional(),
  detail: z.unknown().optional(),
  code: z.string().optional()
}
export const boardConversationResponse = z
  .object({
    ok: z.boolean(),
    messages: z.array(boardConversationTurn).optional(),
    ...refusalFields
  })
  .passthrough()
export const boardMessageRequest = boardConversationRequest.extend({
  content: z.string().trim().min(1)
})
export const boardMessageTurn = boardConversationTurn.extend({
  delivered_live: z.boolean().optional(),
  queued_for_next_attempt: z.boolean().optional()
})
// send_work_action nests the unmodified hub turn inside payload.
export const boardMessageResponse = boardMessageTurn
  .extend({
    ok: z.boolean(),
    status: z.number().optional(),
    payload: boardMessageTurn.optional(),
    ...refusalFields
  })
  .passthrough()
export type TeamRoutineRun = z.infer<typeof teamRoutineRun>
export type BoardConversationTurn = z.infer<typeof boardConversationTurn>
export type BoardMessageTurn = z.infer<typeof boardMessageTurn>
export type ConsoleRoutineConversationApi = {
  getConversation(
    args: z.infer<typeof boardConversationRequest>
  ): Promise<ConsoleWorkflowResult<z.infer<typeof boardConversationResponse>>>
  postMessage(
    args: z.infer<typeof boardMessageRequest>
  ): Promise<ConsoleWorkflowResult<z.infer<typeof boardMessageResponse>>>
}
