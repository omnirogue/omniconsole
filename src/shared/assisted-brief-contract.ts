import { z } from 'zod'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

export const ASSISTED_BRIEF_PROMPT_MAX_CHARS = 60_000

const workspaceTarget = {
  /** Local folder or worktree path, or the path on the SSH host when connectionId is set. */
  worktreePath: z.string().min(1).max(4096),
  connectionId: z.string().min(1).max(512).optional()
}

/** One read-only drafting or review run; the prompt is built from shared, tested builders. */
export const assistedBriefGenerateRequest = z
  .object({
    purpose: z.enum(['draft', 'challenge']),
    ...workspaceTarget,
    agent: z.custom<TuiAgent>((value) => isTuiAgent(value)),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(40).optional(),
    accountChoiceId: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(ASSISTED_BRIEF_PROMPT_MAX_CHARS)
  })
  .strict()
export type AssistedBriefGenerateRequest = z.infer<typeof assistedBriefGenerateRequest>

export const assistedBriefCancelRequest = z.object(workspaceTarget).strict()
export type AssistedBriefCancelRequest = z.infer<typeof assistedBriefCancelRequest>

export type AssistedBriefGenerateResult =
  | { ok: true; text: string; actorLabel: string }
  | { ok: false; error: string; canceled?: boolean }

export type AssistedBriefApi = {
  generate: (args: AssistedBriefGenerateRequest) => Promise<AssistedBriefGenerateResult>
  cancel: (args: AssistedBriefCancelRequest) => Promise<void>
}
