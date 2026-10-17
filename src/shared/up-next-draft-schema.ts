/**
 * What a person may author in Up next, on the wire and on disk.
 *
 * ONE schema for both: the RPC validates a draft with it, and the profile state file is
 * read back through it, so a draft that survived a restart is exactly a draft that could
 * have been sent. Nothing here carries state, numbering, progress or a step id — those are
 * the runtime's to say, and a caller must not be able to assert them.
 */

import { z } from 'zod'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import { handoffArtifactReview } from './handoff-artifact-review'
import { consoleWorkflowLoopStopRule } from './console-workflow-loop'
import { normalizeConversationSource } from './conversation-source'
import { PROMPT_QUEUE_MAX_TEXT_LENGTH } from './prompt-queue-types'
import { SESSION_ACTION_PRESET_IDS } from './session-action-presets'
import { SESSION_FOLLOW_UP_MAX_NOTE_CHARS } from './session-follow-up-rule'
import { WORK_PLAN_MAX_REVIEW_ROUNDS } from './work-plan-types'
import {
  UP_NEXT_MAX_BLOCKS,
  UP_NEXT_MAX_PEOPLE,
  UP_NEXT_MAX_SEATS_PER_STAGE,
  type UpNextBlockPatch,
  type UpNextConversationId,
  type UpNextDraftInput
} from './up-next-types'

export const UP_NEXT_MAX_DRAFTS = 20
export const UP_NEXT_MAX_INSTRUCTION_CHARS = 32_000

const blockId = z.string().min(1).max(256)
const employeeId = z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/)

export const upNextAdvancedSchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(64).optional(),
    rounds: z.number().int().min(1).max(WORK_PLAN_MAX_REVIEW_ROUNDS).optional(),
    stopWhen: consoleWorkflowLoopStopRule.optional(),
    readsFrom: z.array(blockId).max(UP_NEXT_MAX_BLOCKS).optional(),
    endOnSuccess: z.boolean().optional()
  })
  .strict()

const promptDraft = z
  .object({
    kind: z.literal('prompt'),
    text: z.string().min(1).max(PROMPT_QUEUE_MAX_TEXT_LENGTH),
    when: z.enum(['now', 'after']).optional(),
    targetBlockId: blockId.optional()
  })
  .strict()

const agentDraft = z
  .object({
    kind: z.literal('agent'),
    template: z.enum([...SESSION_ACTION_PRESET_IDS, 'custom']),
    shape: z.enum(['solo', 'parallel', 'council', 'best-of', 'custom']).optional(),
    n: z.number().int().min(1).max(UP_NEXT_MAX_SEATS_PER_STAGE).optional(),
    instruction: z.string().max(UP_NEXT_MAX_INSTRUCTION_CHARS).optional(),
    advanced: upNextAdvancedSchema.optional()
  })
  .strict()

const personDraft = z
  .object({
    kind: z.literal('person'),
    /** Absent until the person chooses; a block with no relationship is legal. */
    relationship: z.enum(['handoff', 'review']).optional(),
    people: z
      .array(z.object({ id: employeeId, name: z.string().min(1).max(200) }).strict())
      .max(UP_NEXT_MAX_PEOPLE)
      .optional(),
    /**
     * Ids alone, accepted so a caller that has not got the names to hand still composes.
     * The handoff request CARRIES the name the person saw, so `people` is the one to send:
     * an id-only recipient reaches the hub named by its id.
     */
    peopleIds: z.array(employeeId).max(UP_NEXT_MAX_PEOPLE).optional(),
    receive: z
      .object({
        files: z.boolean().optional(),
        transcript: z.boolean().optional(),
        note: z.string().max(SESSION_FOLLOW_UP_MAX_NOTE_CHARS).optional(),
        createTaskCard: z.boolean().optional(),
        attachTaskId: z.string().regex(BOARD_TASK_ID_PATTERN).optional(),
        // Why: the hub's due_at takes an offset and no fractional seconds (`up-next-person-due.ts`).
        dueAt: z.string().max(64).datetime({ offset: true, precision: 0 }).optional(),
        /** A page the people are asked to decide on; an edit that omits it takes it off. */
        artifact: handoffArtifactReview.optional()
      })
      .strict()
      .optional()
  })
  .strict()

const doneDraft = z
  .object({
    kind: z.literal('done'),
    finish: z.enum(['close', 'save']).optional(),
    folderId: z.string().min(1).max(200).optional()
  })
  .strict()

export const upNextDraftInputSchema: z.ZodType<UpNextDraftInput> = z.discriminatedUnion('kind', [
  promptDraft,
  agentDraft,
  personDraft,
  doneDraft
])

/** An edit names the kind it believes the block is; a mismatch is refused, not guessed. */
export const upNextBlockPatchSchema: z.ZodType<UpNextBlockPatch> = z.discriminatedUnion('kind', [
  promptDraft
    .partial()
    .extend({ kind: z.literal('prompt') })
    .strict(),
  agentDraft
    .partial()
    .extend({ kind: z.literal('agent') })
    .strict(),
  personDraft
    .partial()
    .extend({ kind: z.literal('person') })
    .strict(),
  doneDraft
    .partial()
    .extend({ kind: z.literal('done') })
    .strict()
])

/**
 * One uncommitted block. `afterBlockId` is the committed block it follows, so a draft keeps
 * its place in the chain across a reload; absent means "after everything already queued".
 * `place: 'head'` is the other end: the next thing the current agent hears, ahead of every
 * stage — which is what `/next …` means when a chain is already queued below the Now row.
 */
export type UpNextDraftEntry = {
  id: string
  input: UpNextDraftInput
  afterBlockId?: string
  place?: 'head'
  /**
   * This block was QUEUED behind a person review: the host owns it, and commits it as the
   * next plan version once every named reviewer has replied. It is no longer a draft the
   * person has to send — it is work waiting for a gate — so it reads as `waiting`, and the
   * person may still move or remove it until it launches.
   */
  held?: { reviewStepId: string; committedAt: number }
  createdAt: number
}

export type UpNextDraftRecord = {
  /** The conversation, thread or card these blocks were composed on. */
  subject: UpNextConversationId
  entries: UpNextDraftEntry[]
  updatedAt: number
}

export type UpNextDrafts = Record<string, UpNextDraftRecord>

/** A conversation by address, or a thread/card by its own identity. */
export const upNextSubjectSchema: z.ZodType<UpNextConversationId> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pty'),
      worktreeId: z.string().min(1).max(512),
      paneKey: z.string().min(1).max(512),
      sessionId: z.string().min(1).max(512).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('structured'),
      worktreeId: z.string().min(1).max(512),
      paneKey: z.string().min(1).max(512),
      sessionId: z.string().min(1).max(512)
    })
    .strict(),
  z.object({ kind: z.literal('thread'), threadId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('card'), taskId: z.string().min(1).max(200) }).strict()
])

const entrySchema = z
  .object({
    id: z.string().min(1).max(200),
    input: upNextDraftInputSchema,
    afterBlockId: blockId.optional(),
    place: z.literal('head').optional(),
    held: z
      .object({
        reviewStepId: z.string().min(1).max(200),
        committedAt: z.number().finite().nonnegative()
      })
      .strict()
      .optional(),
    createdAt: z.number().finite().nonnegative()
  })
  .strict()

/** Null when the record cannot be read; one unreadable ENTRY drops itself and keeps the rest. */
export function normalizeUpNextDraftRecord(raw: unknown): UpNextDraftRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const parsed = upNextSubjectSchema.safeParse(value.subject)
  // A record written before threads and cards could be composed on names its conversation.
  const subject = parsed.success ? parsed.data : normalizeConversationSource(value.subject)
  if (!subject) {
    return null
  }
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .map((entry) => entrySchema.safeParse(entry))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .slice(0, UP_NEXT_MAX_DRAFTS)
  return {
    subject,
    entries,
    updatedAt: typeof value.updatedAt === 'number' && value.updatedAt >= 0 ? value.updatedAt : 0
  }
}

export function normalizeUpNextDrafts(raw: unknown): UpNextDrafts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const drafts: UpNextDrafts = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const record = normalizeUpNextDraftRecord(value)
    if (record?.entries.length) {
      drafts[key] = record
    }
  }
  return drafts
}

export function emptyUpNextDraftRecord(subject: UpNextConversationId): UpNextDraftRecord {
  return { subject, entries: [], updatedAt: 0 }
}
