// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AskAnswerKeyGroup } from './native-chat-interactive-prompt'
import type { AgentType } from '../../../../shared/agent-status-types'
import { wrapTerminalBracketedPasteText } from '../terminal-pane/terminal-bracketed-paste'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatPasteBytes,
  buildNativeChatSubmitParts,
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  canSubmitRuntimeSessionInput,
  cancelRuntimeSessionInput
} from '@/runtime/runtime-session-input'
import { sendNativeChatMessageThroughSessionQueue } from './native-chat-session-input-send'
import type { NativeChatSendHandle, NativeChatSendOptions } from './native-chat-send-contract'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../shared/agent-tui-command-typing'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { resetNativeChatPtySendQueuesForTests }

export { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, NATIVE_CHAT_CLEAR_CONFIRM_MS }
export type { NativeChatSendHandle, NativeChatSendOptions }

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

export function clearUnsubmittedAgentInput(
  settings: RuntimeSettings,
  ptyId: string,
  options?: NativeChatSendOptions
): void {
  sendRuntimePtyInput(settings, ptyId, options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
}

/**
 * Run `writeBody` once the input line is clear. With no `confirmCleared` the
 * clear is a plain in-order write on the same byte stream, so the TUI consumes
 * it before the body and the body follows immediately. With one, we pause to
 * actually look at the agent's input line, and widen to a maximal burst when the
 * draft is still visible — the injected line count is only a lower bound on what
 * the buffer holds, since the user can type into the TUI directly.
 */
export function clearThenWrite(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void
): void {
  clearUnsubmittedAgentInput(settings, ptyId, options)
  const confirmCleared = options?.confirmCleared
  if (!confirmCleared) {
    writeBody()
    return
  }
  delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
    let cleared = false
    try {
      cleared = confirmCleared()
    } catch {
      // An unreadable terminal is unconfirmed; the maximal clear remains safe.
    }
    if (!cleared) {
      sendRuntimePtyInput(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX)
    }
    writeBody()
  })
}

/** Extra time a send needs when it stops to confirm the clear before the body. */
export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}

/**
 * Chat message path:
 *   1. clear any unsubmitted TUI line
 *   2. write framed body
 *   3. delayed Enter (separate write — same-write CR can be swallowed by paste)
 *
 * Delivered as ONE item by the host's session input queue, which also orders it
 * against chain step launches and worker prompts on the same session. The direct
 * writes below remain for a target this client writes itself — a remote runtime
 * whose host has no queue entry point.
 */
export function sendNativeChatMessage(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (canSubmitRuntimeSessionInput(ptyId)) {
    return sendNativeChatMessageThroughSessionQueue(ptyId, text, options)
  }
  const parts = buildNativeChatSubmitParts(text, options?.agent)
  return enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearThenWrite(settings, ptyId, options, delay, () => {
        if (isCancelled()) {
          return
        }
        if (parts.body) {
          sendRuntimePtyInput(settings, ptyId, parts.body)
        }
        // Why: a delayed clear-confirm must not collapse the agent's settle window.
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(settings, ptyId, parts.submit)
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options)
    }
  )
}

function waitForNativeChatSubmit(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (completed: boolean): void => {
      if (timer === null) {
        return
      }
      clearTimeout(timer)
      timer = null
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    timer = setTimeout(() => finish(true), NATIVE_CHAT_SUBMIT_DELAY_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Session-option / slash command path (model switch, /effort, …).
 *
 * Does not pre-clear the line (model-switch confirmation watches the PTY).
 * Cancels any in-flight chat clear/body/Enter on this PTY first so a delayed
 * chat Enter cannot dismiss Claude's "Switch model?" dialog.
 */
export async function sendNativeChatMessageVerified(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  signal?: AbortSignal,
  agent?: AgentType
): Promise<boolean> {
  // Why: chat sends hold a delayed Enter for 500ms. Opening the model picker in
  // that window used to let that Enter hit Claude's confirmation UI, so
  // verification timed out with "Could not verify the model change".
  cancelNativeChatPtySends(ptyId)
  // Why chat-only: this takes the line from chat's own sends. A chain step's or a
  // worker's item on this session belongs to someone else and must not be dropped.
  await cancelRuntimeSessionInput(ptyId, { origin: 'chat' })
  await waitForNativeChatPtyIdle(ptyId)
  if (signal?.aborted) {
    return false
  }

  // OMP's completion popup consumes a delayed Enter; submit inside the paste event.
  if (agent === 'omp') {
    return sendRuntimePtyInputVerified(
      settings,
      ptyId,
      wrapTerminalBracketedPasteText(text) + NATIVE_CHAT_SUBMIT
    )
  }

  // Why: option commands await remote/SSH acceptance so the Enter cannot race
  // ahead of the body while a model-change observer is already armed.
  const bodyAccepted = await sendRuntimePtyInputVerified(
    settings,
    ptyId,
    buildNativeChatPasteBytes(text)
  )
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

/** Types a slash command as individual keys so Codex opens its command palette. */
export async function typeNativeChatCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string,
  signal?: AbortSignal
): Promise<boolean> {
  cancelNativeChatPtySends(ptyId)
  await cancelRuntimeSessionInput(ptyId, { origin: 'chat' })
  await waitForNativeChatPtyIdle(ptyId)
  const outcome = await typeAgentTuiCommand({
    command,
    signal,
    write: async (key) =>
      (await sendRuntimePtyInputVerified(settings, ptyId, key)) ? 'accepted' : 'rejected'
  })
  return outcome === 'accepted'
}

/** Queues a typed slash command with composer sends on the same PTY. */
export function sendNativeChatTypedCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string
): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          clearUnsubmittedAgentInput(settings, ptyId)
        }
        markSubmitted()
      }
      void typeAgentTuiCommand({
        command,
        signal: controller.signal,
        write: async (key) => {
          if (isCancelled()) {
            return 'rejected'
          }
          return (await sendRuntimePtyInputVerified(settings, ptyId, key)) ? 'accepted' : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      onCancelUnsubmitted: () => {
        controller.abort()
        clearUnsubmittedAgentInput(settings, ptyId)
      }
    }
  )
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(settings: RuntimeSettings, ptyId: string): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

/** Why an answer went unsent: keys already landed (`partial`), the dialog is not on screen, or
 *  the terminal refused the first keys (`not-delivered`). */
export type AskAnswerRefusal = 'partial' | 'not-on-screen' | 'not-delivered'

/**
 * Answer a native question with paced, accepted keystroke groups. Navigation
 * must be accepted before Enter can commit the selected answer.
 */
export function sendNativeChatAskAnswer(
  settings: RuntimeSettings,
  ptyId: string,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean, refusal?: AskAnswerRefusal) => void,
  /** Resolves false to stop before this group is written (its dialog step is not on screen). */
  beforeGroup?: (group: AskAnswerKeyGroup) => Promise<boolean>
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  let cancelled = false
  let timer: ReturnType<typeof setTimeout>
  const refuse = (index: number, gated: boolean): void => {
    if (index > 0) {
      onSettled?.(false, 'partial')
    } else {
      onSettled?.(false, gated ? 'not-on-screen' : 'not-delivered')
    }
  }
  const deliver = async (index: number): Promise<void> => {
    if (cancelled) {
      return
    }
    const group = groups[index]!
    if (beforeGroup && !(await beforeGroup(group).catch(() => false))) {
      if (!cancelled) {
        refuse(index, true)
      }
      return
    }
    if (cancelled) {
      return
    }
    const bytes = 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text)
    const accepted = await sendRuntimePtyInputVerified(settings, ptyId, bytes, {
      requireAcceptance: true
    }).catch(() => false)
    if (cancelled) {
      return
    }
    if (!accepted) {
      refuse(index, false)
      return
    }
    const hasNext = index < groups.length - 1
    timer = setTimeout(
      () => {
        if (hasNext) {
          void deliver(index + 1)
        } else if (!cancelled) {
          onSettled?.(true)
        }
      },
      hasNext ? NATIVE_CHAT_QUESTION_STEP_MS : NATIVE_CHAT_SUBMIT_DELAY_MS
    )
  }
  // Let the caller retain the cancel handle before starting delivery.
  timer = setTimeout(() => void deliver(0), 0)
  const settleAfterMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  return {
    cancel: () => {
      cancelled = true
      clearTimeout(timer)
    },
    // Minimum pacing duration; onSettled also waits for transport acceptance.
    settleAfterMs
  }
}
