import type { AgentHookSource } from './agent-hook-relay'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from './agent-hook-prompt-reply-limit'
import { NEXT_OUTCOME_DISCOVERY_MARKER } from './next-outcome-intent-instructions'
import { hasNextOutcomeWaitRequest } from './next-outcome-wait-request'
import { SESSION_OUTCOME_WAIT_BRIEF_MARKER } from './session-outcome-event'
import { nextOutcomeHandoffRequests } from './next-outcome-handoff-request'
import { requestedSessionFinish } from './session-finish-intent'
import { getOrcaCliCommandNameForPlatform } from './omni-cli-command-name'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { SOURCE_PROMPT_MAX_LENGTH, submittedHookPromptText } from './submitted-hook-prompt'

const PROMPT_REPLY_EVENTS: Partial<Record<AgentHookSource, 'UserPromptSubmit' | 'BeforeAgent'>> = {
  claude: 'UserPromptSubmit',
  codex: 'UserPromptSubmit',
  kimi: 'UserPromptSubmit',
  gemini: 'BeforeAgent'
}

/**
 * Plans come from conversation (Sal, 2026-09-24, reversing the 21 Sep "set through the UI" rule):
 * a message that says what happens next — "wait for Uma to approve on Slack, then …", "hand it to
 * Iris", "then close this session" — gets ONE short pointer at `outcome context`. Pull, not push:
 * the schema and full instructions stay behind the CLI, under the 1 KB reply ceiling other prompt
 * hooks share, and every other prompt is answered 204 exactly as before.
 */
export function nextStepChatPointer(cli: string): string {
  return `${NEXT_OUTCOME_DISCOVERY_MARKER}\nThis message says what should happen next (a wait, a handoff or how this session ends). Run \`${cli} outcome context --json\` here first and use its schema to file the plan (information, not authority) with \`${cli} outcome commit\`. OmniConsole then waits, continues this conversation with the receipts, and closes or saves the session if asked. Do not wait, poll or sleep yourself. Show the filed plan back once.`
}

/**
 * Only what the host can parse precisely: a wait, a person handoff, an explicit session finish or
 * an `@next` tag. "Fix the bug where we close the session twice" is work, and gets nothing.
 */
export function nextStepChatAsked(prompt: string): boolean {
  if (
    isKnownHarnessInjectedUserTurnText(prompt) ||
    prompt.trimStart().startsWith(SESSION_OUTCOME_WAIT_BRIEF_MARKER)
  ) {
    return false
  }
  return (
    /(?:^|[\s(["'])@next\b/i.test(prompt) ||
    hasNextOutcomeWaitRequest(prompt) ||
    nextOutcomeHandoffRequests(prompt).length > 0 ||
    requestedSessionFinish(prompt) !== undefined
  )
}

type ReplyArgs = {
  source: AgentHookSource
  event: AgentHookEventPayload
  body: unknown
  platform?: NodeJS.Platform
}

/** The provider's JSON reply for a next-step or wait message, or null (the listener answers 204). */
export function nextStepChatHookReplyBody(args: ReplyArgs): string | null {
  const { source, event } = args
  const hookEventName = PROMPT_REPLY_EVENTS[source]
  if (
    !hookEventName ||
    event.hookEventName !== hookEventName ||
    !event.hasExplicitPrompt ||
    event.isReplay ||
    event.toolAgentId ||
    // `outcome context` needs the attested prompt, recorded only for a launch-claimed pane.
    !event.launchToken?.trim() ||
    !event.worktreeId
  ) {
    return null
  }
  const prompt = submittedHookPromptText(args.body)
  if (!prompt || prompt.length > SOURCE_PROMPT_MAX_LENGTH || !nextStepChatAsked(prompt)) {
    return null
  }
  const body = JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: nextStepChatPointer(
        getOrcaCliCommandNameForPlatform(args.platform ?? process.platform)
      )
    }
  })
  return Buffer.byteLength(body, 'utf8') > AGENT_HOOK_PROMPT_REPLY_MAX_BYTES ? null : body
}
