// `sessionQuestions.list`: what sessions on this computer are asking the person
// (`omni session questions`). Local callers only, like every session-manage read.

import {
  SESSION_QUESTIONS_RPC,
  SessionQuestionsParamsSchema,
  type SessionQuestionsResult
} from '../../../../shared/session-questions'
import { agentHookServer } from '../../../agent-hooks/server'
import { assertSessionManageCaller } from '../../../session-manage/session-manage-caller'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { listPendingSessionQuestions } from '../../../session-questions/session-questions-list'
import { defineMethod } from '../core'

export const SESSION_QUESTIONS_METHOD = defineMethod({
  name: SESSION_QUESTIONS_RPC.list,
  params: SessionQuestionsParamsSchema,
  handler: async (_params, context): Promise<SessionQuestionsResult> => {
    assertSessionManageCaller(context)
    // Why tolerate a missing window: the questions come from the hooks, titles are a nicety.
    const rows = await readSidebarRows(context.runtime).catch(() => [])
    const titles = new Map(
      rows.filter((row) => row.paneKey).map((row) => [row.paneKey as string, row.title])
    )
    return {
      questions: listPendingSessionQuestions(
        agentHookServer.getStatusSnapshot(),
        (paneKey) => agentHookServer.getToolUseIdForPane(paneKey),
        (paneKey) => titles.get(paneKey) ?? null
      )
    }
  }
})
