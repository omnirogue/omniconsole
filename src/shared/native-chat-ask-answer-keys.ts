import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  type AskAnswerKeyGroup,
  type AskAnswerSelection
} from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'
import { resolveAskAnswerKeyAgent, type AskAnswerKeyAgent } from './native-chat-agent-support'
import { buildGeminiAskAnswerKeys } from './native-chat-gemini-ask'
import { buildGrokAskAnswerKeys } from './native-chat-grok-ask'
import { buildHermesAskAnswerKeys } from './native-chat-hermes-ask'
import { buildOmpAskAnswerKeys } from './native-chat-omp-ask'
import { isOptionOnlyAnswerable } from './native-chat-option-only-ask'
import { buildQwenAskAnswerKeys } from './native-chat-qwen-ask'

/** The selector keystrokes answering `prompt` for this agent; empty means "do not send". */
export function buildAgentAskAnswerKeys(
  agent: AskAnswerKeyAgent,
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  switch (agent) {
    case 'claude':
      return buildAskAnswerKeys(prompt, selections)
    case 'codex':
      return buildCodexAskAnswerKeys(prompt, selections)
    case 'omp':
      return buildOmpAskAnswerKeys(prompt, selections)
    case 'grok':
      return buildGrokAskAnswerKeys(prompt, selections)
    case 'gemini':
      return buildGeminiAskAnswerKeys(prompt, selections)
    case 'qwen':
      return buildQwenAskAnswerKeys(prompt, selections)
    case 'hermes':
      return buildHermesAskAnswerKeys(prompt, selections)
  }
}

/** What the card may offer: free text, and whether a click can answer at all. */
export type AskAnswerSurface = {
  allowOther: boolean
  /** Every question must be answered before submitting (no skips). */
  requireEveryAnswer: boolean
  /** No one-click answer is safe; the person answers in the terminal. */
  answerInTerminal: boolean
}

/** Gemini, Qwen and Hermes selectors take option keys only, so the card refuses what their builders refuse. */
export function resolveAskAnswerSurface(
  agent: string | null | undefined,
  prompt: AskPrompt
): AskAnswerSurface {
  const keyAgent = resolveAskAnswerKeyAgent(agent)
  if (keyAgent !== 'gemini' && keyAgent !== 'qwen' && keyAgent !== 'hermes') {
    return { allowOther: true, requireEveryAnswer: false, answerInTerminal: false }
  }
  return {
    allowOther: false,
    requireEveryAnswer: true,
    answerInTerminal: !isOptionOnlyAnswerable(prompt, {
      allowMultiSelect: keyAgent === 'qwen'
    })
  }
}
