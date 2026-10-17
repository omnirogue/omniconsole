import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { NATIVE_CHAT_QUESTION_STEP_MS } from '../../../../shared/native-chat-answer-stepping'
import type { NativeChatSendHandle } from './native-chat-send-contract'

function waitForApprovalKey(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), NATIVE_CHAT_QUESTION_STEP_MS)
    const finish = (completed: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** An approval's Enter must never overtake a rejected or unacknowledged selector key. */
export function sendNativeChatApproval(args: {
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>
  ptyId: string
  keys: readonly string[]
  isCurrent: () => boolean
  onSettled: (delivered: boolean) => void
}): NativeChatSendHandle {
  const controller = new AbortController()
  let finished = false
  let submitted = false
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  const finish = (delivered: boolean): void => {
    if (finished) {
      return
    }
    finished = true
    submitted = delivered
    resolveSettled()
    args.onSettled(delivered)
  }
  const deliver = async (): Promise<void> => {
    for (let index = 0; index < args.keys.length; index += 1) {
      if (finished || !args.isCurrent()) {
        finish(false)
        return
      }
      const accepted = await sendRuntimePtyInputVerified(
        args.settings,
        args.ptyId,
        args.keys[index]!,
        { requireAcceptance: true }
      )
      if (finished || !accepted) {
        finish(false)
        return
      }
      if (index < args.keys.length - 1 && !(await waitForApprovalKey(controller.signal))) {
        finish(false)
        return
      }
    }
    finish(args.keys.length > 0)
  }
  // Let the caller retain the handle before a synchronous refusal can settle it.
  void Promise.resolve()
    .then(deliver)
    .catch(() => finish(false))
  return {
    cancel: () => {
      controller.abort()
      finish(false)
    },
    settleAfterMs: Math.max(1, args.keys.length) * NATIVE_CHAT_QUESTION_STEP_MS,
    settled,
    wasSubmitted: () => submitted
  }
}
