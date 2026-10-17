import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { asyncAskPendingInStatus } from '../../../src/shared/codex-async-question'
import { parseAskFromStatus, resolveNativeChatAsk } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { detectAgentPermission, parseApprovalFromStatus } from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'

export type MobileNativeChatPrompts = {
  permission: ReturnType<typeof detectAgentPermission>
  question: ReturnType<typeof parseAgentQuestion>
  detectedAsk: ReturnType<typeof parseAskFromStatus>
  ask: ReturnType<typeof parseAskFromStatus>
}

/** Derives the prompt cards shown above the composer. */
export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  status: AgentStatusEntry | null | undefined
  messages: readonly NativeChatMessage[]
  /** True while `messages` is an unsettled read (including the cached list held
   *  across a reconnect). Required: an ask derived from it may already be answered. */
  transcriptLoading: boolean
}): MobileNativeChatPrompts {
  const { enabled, status, messages, transcriptLoading } = args
  const blocked = status?.state === 'waiting' || status?.state === 'blocked'
  const askFromStatus = useMemo(
    () => parseAskFromStatus(status?.interactivePrompt, status?.toolName),
    [status?.interactivePrompt, status?.toolName]
  )
  // Why no heuristics then: an async question takes a message, and Codex sits idle at its
  // composer, so a menu read from its prose would type raw keys there.
  const heuristics = blocked && status && askFromStatus?.delivery !== 'async' ? status : null
  // Both permission paths sit inside the paused gate: an approval envelope can
  // outlive its answer (the host keeps it sticky), so only a waiting/blocked
  // agent may surface it — never a working or done one (STA-3144).
  const permission = heuristics
    ? (detectAgentPermission({
        state: heuristics.state,
        lastAssistantMessage: heuristics.lastAssistantMessage,
        toolName: heuristics.toolName,
        toolInput: heuristics.toolInput
      }) ?? parseApprovalFromStatus(heuristics.interactivePrompt))
    : null
  const question =
    heuristics && !permission ? parseAgentQuestion(heuristics.lastAssistantMessage ?? '') : null
  // Why not only while paused: an async question rides the finished turn that asked it.
  const liveAsk =
    askFromStatus && status && asyncAskPendingInStatus(status, askFromStatus.delivery)
      ? askFromStatus
      : null
  const resolvedAsk = useMemo(
    () =>
      resolveNativeChatAsk({
        liveAsk: askFromStatus,
        messages,
        transcriptSettled: !transcriptLoading
      }),
    [askFromStatus, transcriptLoading, messages]
  )
  const askFromMessages = askFromStatus ? null : resolvedAsk
  const detectedAsk = askFromStatus ?? askFromMessages

  return {
    permission,
    question,
    detectedAsk: enabled ? detectedAsk : null,
    // Only the status payload needs the paused gate the approval envelope uses:
    // it outlives its answer, so a working/done agent must not surface one. The
    // transcript fallback clears itself when the tool result lands, and it is the
    // only source left once the hook row goes stale and projects to `done` with
    // no interactivePrompt — gating it too strands a genuinely pending question.
    ask: enabled ? (liveAsk ?? askFromMessages) : null
  }
}
