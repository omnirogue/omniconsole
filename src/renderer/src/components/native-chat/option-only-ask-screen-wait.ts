import type { AskAnswerKeyGroup, AskPrompt } from '../../../../shared/native-chat-ask'
import {
  readOptionOnlyAskScreen,
  type OptionOnlyAskScreenAgent
} from '../../../../shared/option-only-ask-screen'

// Why a wait: a tab-advancing digit re-renders the next question some hundreds of ms later, and a
// key sent before that is dropped (seen live on Qwen at ~0.6 s).
export const OPTION_ONLY_ASK_SCREEN_POLL_MS = 150
export const OPTION_ONLY_ASK_SCREEN_WAIT_MS = 2_500

/** True when the terminal shows this prompt's own dialog now; an unreadable screen is a no. */
export function isOptionOnlyAskOnScreen(
  agent: OptionOnlyAskScreenAgent,
  readScreen: (() => string | null) | undefined,
  prompt: AskPrompt
): boolean {
  try {
    return readOptionOnlyAskScreen(agent, readScreen?.() ?? null, prompt) !== null
  } catch {
    return false
  }
}

/** Resolves true once the dialog shows the step `group` is meant for; false on timeout or cancel. */
export function waitForOptionOnlyAskStep(args: {
  agent: OptionOnlyAskScreenAgent
  prompt: AskPrompt
  group: AskAnswerKeyGroup
  readScreen: (() => string | null) | undefined
  isCancelled: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const { agent, prompt, group, readScreen, isCancelled } = args
  const now = args.now ?? Date.now
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const expected = 'raw' in group ? group.screen : undefined
  const deadline = now() + OPTION_ONLY_ASK_SCREEN_WAIT_MS
  const matches = (): boolean => {
    let step: ReturnType<typeof readOptionOnlyAskScreen> = null
    try {
      step = readOptionOnlyAskScreen(agent, readScreen?.() ?? null, prompt)
    } catch {
      return false
    }
    return step !== null && (expected === undefined || step === expected)
  }
  const poll = async (): Promise<boolean> => {
    while (!isCancelled()) {
      if (matches()) {
        return true
      }
      if (now() >= deadline) {
        return false
      }
      await sleep(OPTION_ONLY_ASK_SCREEN_POLL_MS)
    }
    return false
  }
  return poll()
}
