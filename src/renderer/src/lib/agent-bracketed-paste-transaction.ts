import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'
import {
  canSendAgentPasteThroughSessionQueue,
  sendAgentPasteThroughSessionQueue
} from './agent-paste-session-input'

export const POST_PASTE_SUBMIT_DELAY_MS = 50

export async function sendBracketedPasteToAgent(args: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  beforeWrite?: () => void
  writePty?: (data: string) => Promise<boolean>
}): Promise<boolean> {
  const {
    settings = useAppStore.getState().settings,
    ptyId,
    content,
    submit,
    agent,
    beforeWrite
  } = args
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  if (canSendAgentPasteThroughSessionQueue(args)) {
    // Why: one queued item instead of a renderer-held paste→Enter window, so a
    // chat send can no longer clear the pasted prompt and submit its own text
    // inside it. Callers that re-check authority per write keep the path below.
    return await sendAgentPasteThroughSessionQueue({
      ptyId,
      content,
      submit,
      ...(agent ? { agent } : {}),
      postPasteSubmitDelayMs: POST_PASTE_SUBMIT_DELAY_MS
    })
  }
  try {
    // Why: paste + Enter (+ retry Enter) must be one transaction, or a concurrent
    // paste on this PTY can slip between them and submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      // Why: authority can change while queued, measuring a large paste, or awaiting Enter.
      beforeWrite?.()
      let customWriteFailure: { error: unknown } | undefined
      const writePty =
        beforeWrite || args.writePty
          ? async (data: string): Promise<boolean> => {
              try {
                beforeWrite?.()
                return await (args.writePty
                  ? args.writePty(data)
                  : sendRuntimePtyInputVerified(settings, ptyId, data))
              } catch (error) {
                customWriteFailure ??= { error }
                throw error
              }
            }
          : undefined
      const pasted = await sendAgentDraftPasteContentNow(settings, ptyId, content, writePty)
      if (args.writePty && customWriteFailure) {
        throw customWriteFailure.error
      }
      if (!pasted || !submit) {
        return pasted
      }

      // Why: Claude Code can leave a prompt as editable text when paste-end and
      // Enter arrive in the same PTY write. Split the submit into the next turn so
      // the TUI processes bracketed-paste termination before handling Enter.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      beforeWrite?.()
      const submitted = await (writePty
        ? writePty('\r')
        : sendRuntimePtyInputVerified(settings, ptyId, '\r'))

      if (submitRetryDelayMs !== undefined) {
        // Why: agents that render their composer before Enter is live silently eat
        // the first Enter; the retry is best-effort and never downgrades `submitted`.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          beforeWrite?.()
          await (writePty ? writePty('\r') : sendRuntimePtyInputVerified(settings, ptyId, '\r'))
        } catch (error) {
          if (args.writePty) {
            throw error
          }
          // Why: a rejected retry leaves the first Enter's verdict untouched.
        }
      }

      return submitted
    })
  } catch (error) {
    if (args.writePty) {
      throw error
    }
    return false
  }
}
