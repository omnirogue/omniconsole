/**
 * The wire shape of an Up next call.
 *
 * The draft and patch schemas are the SHARED ones (`up-next-draft-schema.ts`): the same
 * validator guards the wire and the profile state file, so a draft that survived a restart
 * is exactly a draft that could have been sent. Nothing a caller sends carries state,
 * numbering, progress or a step id — the runtime owns those.
 */

import { z } from 'zod'
import {
  upNextBlockPatchSchema,
  upNextDraftInputSchema,
  upNextSubjectSchema
} from '../../../../shared/up-next-draft-schema'
import { UP_NEXT_MAX_BLOCKS } from '../../../../shared/up-next-types'
import { requiredString } from '../schemas'

/**
 * What the call is about: a conversation by address (workspace, pane, door), or a thread or
 * card by its own identity. The conversation shape is unchanged — `{kind:'pty'|'structured',
 * worktreeId, paneKey, sessionId?}` — so every existing caller keeps working.
 *
 * `sessionId` stays OPTIONAL at the wire, even though a chat conversation cannot be written
 * to without one: the handler then refuses it in a sentence a person can read, rather than
 * with a schema dump about a field they never chose.
 */
export const UpNextConversationIdSchema = z.union([
  z
    .object({
      kind: z.enum(['pty', 'structured']),
      worktreeId: requiredString('Missing workspace'),
      paneKey: requiredString('Missing conversation pane'),
      sessionId: z.string().min(1).max(512).optional()
    })
    .strict(),
  upNextSubjectSchema
])

const BlockId = requiredString('Missing block').pipe(z.string().max(256))
const Conversation = z
  .object({
    conversationId: UpNextConversationIdSchema,
    expectedExecutionRuntimeId: z.string().min(1).max(512).optional()
  })
  .strict()
const Block = Conversation.extend({ blockId: BlockId }).strict()

export const UP_NEXT_PARAMS = {
  list: Conversation,
  append: Conversation.extend({
    draft: upNextDraftInputSchema,
    /** `head` sends it to the agent working now, ahead of every queued stage. */
    position: z.enum(['head', 'end']).optional(),
    insertAfterBlockId: BlockId.optional()
  }).strict(),
  update: Block.extend({ patch: upNextBlockPatchSchema }).strict(),
  /** −1 is one place earlier, 1 one place later; a cap is never crossed. */
  reorder: Block.extend({ direction: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  remove: Block,
  commit: Conversation.extend({
    adoptFrom: upNextSubjectSchema.optional(),
    /**
     * Queue ONLY these composed blocks. Absent queues everything composed, which is what
     * the composer's own button does; `/next` names the one prompt it just wrote, so a
     * command never queues the blocks the person is still editing beside it.
     */
    blockIds: z.array(BlockId).min(1).max(UP_NEXT_MAX_BLOCKS).optional()
  }).strict(),
  discardDrafts: Conversation,
  configureAfter: Block,
  /** A failed queued prompt (`pq:`) goes back to the head of the queue. */
  requeue: Block
} as const

export type UpNextConversationParams = z.infer<typeof Conversation>
