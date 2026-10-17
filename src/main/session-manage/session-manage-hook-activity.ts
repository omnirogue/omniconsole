import { classifyAgentTurnFailure } from '../../shared/agent-turn-failure'
import { asyncAskPendingInStatus } from '../../shared/codex-async-question'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import type { SessionAgentActivity } from './session-manage-state'

/** One hook report for a pane, as the observation reads it. */
export type SessionHookReading = {
  state: 'working' | 'blocked' | 'waiting' | 'done'
  /** `monitoring`: the lead's turn is over and only its children still run. */
  workingMode?: 'monitoring'
  prompt?: string
  interactivePrompt: string | null
  failed?: boolean
  failureReason?: string
  updatedAt: number
  /** The local process that sent it; a report without one is never the current agent's. */
  agentPid?: number
}

export function hookActivity(hook: SessionHookReading): SessionAgentActivity {
  // Why a question while children run: the lead is idle at its composer and its async question
  // waits on the person, as `omni session questions` and Needs you already list it.
  if (
    hook.state === 'working' &&
    hook.interactivePrompt &&
    parseAskFromStatus(hook.interactivePrompt)?.delivery === 'async' &&
    asyncAskPendingInStatus(hook, 'async')
  ) {
    return { kind: 'question', prompt: hook.interactivePrompt }
  }
  if (hook.state === 'working') {
    return { kind: 'working', ...(hook.prompt ? { activity: hook.prompt } : {}) }
  }
  if (hook.interactivePrompt) {
    return { kind: 'question', prompt: hook.interactivePrompt }
  }
  if (hook.state === 'blocked') {
    return { kind: 'permission' }
  }
  if (hook.state === 'waiting') {
    return { kind: 'question' }
  }
  return hook.failed
    ? {
        kind: 'idle',
        failure: hook.failureReason ?? 'The provider gave no reason.',
        usageLimited: classifyAgentTurnFailure(hook.failureReason) === 'usage-limit'
      }
    : { kind: 'idle' }
}
