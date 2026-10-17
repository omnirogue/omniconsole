import { z } from 'zod'

/**
 * WHY an outcome is blocked, said by the writer that blocked it. The free-text `blockedReason`
 * beside it is a diagnostic a person may read under Details; it never decides what the run is doing
 * (`docs/reference/session-run-lifecycle.md`).
 *
 * - `recovering`: the host acts again by itself (`until` = when).
 * - `waiting`: a real wake exists (`wake` names it) — an evidence poll, a named person's reply.
 * - `attention`: the attention requests in `attentionIds` are why this cannot continue.
 * - `failed`: recovery is exhausted or unsafe and no human-only remedy exists.
 */
export const SESSION_OUTCOME_BLOCK_CLASSES = [
  'recovering',
  'waiting',
  'attention',
  'failed'
] as const
export type SessionOutcomeBlockClass = (typeof SESSION_OUTCOME_BLOCK_CLASSES)[number]

const code = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const sessionOutcomeBlockSchema = z
  .object({
    class: z.enum(SESSION_OUTCOME_BLOCK_CLASSES),
    code,
    /** When this block began. Rewriting the same class and code keeps it, so age is measurable. */
    since: z.number().finite().nonnegative(),
    until: z.number().finite().nonnegative().optional(),
    wake: z.string().trim().min(1).max(200).optional(),
    attentionIds: z.array(requestId).max(16).optional()
  })
  .strict()
export type SessionOutcomeBlock = z.infer<typeof sessionOutcomeBlockSchema>
export type SessionOutcomeBlockInput = Omit<SessionOutcomeBlock, 'since'>

/** A `recovering` block nothing cleared in this long was never going to clear by itself. */
export const SESSION_RECOVERING_MAX_MS = 15 * 60_000

/** A blocked outcome no writer classified: honest failure, never a request for a person. */
export const UNCLASSIFIED_BLOCK_CODE = 'unclassified'

/**
 * The block to persist. `since` survives a rewrite of the same class and code, which is what lets a
 * stuck `recovering` block be seen to be stuck; `until`, `wake` and the request list follow the
 * newest write.
 */
export function sessionOutcomeBlock(
  input: SessionOutcomeBlockInput,
  previous: SessionOutcomeBlock | undefined,
  now: number
): SessionOutcomeBlock {
  // Why shaped here: the set's schema is strict, so a code or wake it cannot read would make the
  // whole plan unwritable. A writer's slip must cost a diagnostic, never the record.
  const code =
    input.code
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 64) || UNCLASSIFIED_BLOCK_CODE
  const wake = input.wake?.trim().slice(0, 200)
  const same = previous && previous.class === input.class && previous.code === code
  return {
    class: input.class,
    code,
    since: same ? previous.since : now,
    ...(input.until !== undefined && Number.isFinite(input.until)
      ? { until: Math.max(0, input.until) }
      : {}),
    ...(wake ? { wake } : {}),
    ...(input.attentionIds ? { attentionIds: input.attentionIds.slice(0, 16) } : {})
  }
}

/** What a reader treats a blocked outcome as: its own class, escalated once recovery has gone stale. */
export function effectiveSessionOutcomeBlock(
  outcome: { status: string; block?: SessionOutcomeBlock },
  now: number
): SessionOutcomeBlock | null {
  if (outcome.status !== 'blocked') {
    return null
  }
  const block = outcome.block
  if (!block) {
    return { class: 'failed', code: UNCLASSIFIED_BLOCK_CODE, since: 0 }
  }
  // Staleness runs from the scheduled action, not from the block's start: a long backoff that has
  // only just come due is the host's to act on, and must not read as failed until it has not.
  const idleSince = Math.max(block.since, block.until ?? 0)
  if (block.class === 'recovering' && now - idleSince > SESSION_RECOVERING_MAX_MS) {
    return { ...block, class: 'failed' }
  }
  return block
}
