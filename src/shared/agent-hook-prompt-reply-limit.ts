/**
 * Byte ceiling the managed prompt-hook scripts accept from the listener before relaying a reply to
 * the provider. The listener answers a next-step or wait message with one short pointer at
 * `outcome context` (`next-step-chat-hook-reply.ts`) and every other prompt with an empty 204, for
 * which the scripts print the neutral `{}`.
 */
export const AGENT_HOOK_PROMPT_REPLY_MAX_BYTES = 1024
