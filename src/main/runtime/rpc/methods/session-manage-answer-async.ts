/**
 * `omni session answer` for a Codex async question: the same host function the pane card and
 * Needs you answer through (`agent-question-message-answer.ts`), so both paths share its checks,
 * its one-queue-turn write and its claim on the question. Every check runs in preflight, before
 * Keep going or the pending marker changes.
 */

import { randomUUID } from 'node:crypto'
import { agentHookServer } from '../../../agent-hooks/server'
import type {
  SessionAnswerDelivery,
  SessionAnswerSelection
} from '../../../session-manage/session-manage-answer'
import { SessionManageRefusal } from '../../../session-manage/session-manage-refusal'
import type { SessionPrompt } from '../../../session-manage/session-prompt'
import {
  agentQuestionAnswerTextRefusal,
  confirmAgentQuestionAnswer,
  planAgentQuestionAnswer,
  writeAgentQuestionAnswer,
  type AgentQuestionAnswerPlan,
  type AgentQuestionAnswerRuntime
} from '../../agent-question-message-answer'
import type { TerminalAgentProcessProof } from '../../terminal-agent-process'

export function asyncQuestionAnswerSteps(
  runtime: AgentQuestionAnswerRuntime,
  paneKey: string,
  ownerStillCurrent?: () => boolean
) {
  let planned: { plan: AgentQuestionAnswerPlan; text: string } | null = null
  return {
    validate(chosen: SessionAnswerSelection): void {
      const refused = agentQuestionAnswerTextRefusal(chosen.value)
      if (refused) {
        throw new SessionManageRefusal(refused)
      }
    },
    async preflight(
      prompt: SessionPrompt,
      agentProcess: TerminalAgentProcessProof | null,
      chosen: SessionAnswerSelection
    ): Promise<void> {
      if (prompt.delivery.kind !== 'message') {
        return
      }
      const result = await planAgentQuestionAnswer(
        runtime,
        { paneKey, ptyId: prompt.delivery.ptyId, text: chosen.value },
        {
          expected: agentProcess,
          onAgentGone: (gone) => {
            agentHookServer.dropAsyncQuestion(gone)
          },
          // Why refuse: this path runs unattended (the mirror), and a relay cannot guard the write.
          ssh: 'refuse'
        }
      )
      if ('refusal' in result) {
        throw new SessionManageRefusal(result.refusal)
      }
      planned = { plan: result.plan, text: chosen.value }
    },
    async deliver(
      chosen: SessionAnswerSelection,
      signal?: AbortSignal
    ): Promise<SessionAnswerDelivery> {
      if (!planned || planned.text !== chosen.value) {
        throw new SessionManageRefusal(
          'The answer was not checked before sending. Nothing was sent.'
        )
      }
      const clientMessageId = `session-answer:${randomUUID()}`
      const outcome = await writeAgentQuestionAnswer(
        runtime,
        planned.plan,
        chosen.value,
        clientMessageId,
        signal,
        ownerStillCurrent
      )
      if (outcome.status === 'not-sent') {
        throw new SessionManageRefusal(outcome.reason)
      }
      if (outcome.status === 'unconfirmed') {
        // Why a plain error: some of it reached the terminal, so never "nothing was sent".
        throw new Error(outcome.reason)
      }
      return await confirmAgentQuestionAnswer(runtime, planned.plan, clientMessageId)
    }
  }
}
