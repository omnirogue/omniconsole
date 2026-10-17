import { LOCAL_UP_NEXT_CONNECTION, type UpNextConnection } from './up-next-connection'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'
import {
  isUpNextConversation,
  UP_NEXT_RPC,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextPersonBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { readUpNext, writeUpNext } from './up-next-client'

export type UpNextSurface = {
  start?: () => Promise<ConversationSource>
  readFinish?: (source: ConversationSource) => SessionFinishChoice | undefined
  scheduleFinish?: (choice: SessionFinishChoice | null, source: ConversationSource) => void
  createCard?: (block: UpNextPersonBlock, source: ConversationSource) => Promise<string>
  /** Compatibility for old Done drafts: save a deferred preference, never finish immediately. */
  finish?: (choice: SessionFinishChoice, source: ConversationSource) => Promise<void>
}

/** Surface-owned effects finish before the host adopts and queues the drafts. */
export async function commitUpNext(
  view: UpNextView,
  surface: UpNextSurface,
  onRead: (view: UpNextView) => void,
  onStarted: (source: ConversationSource) => void,
  connection: UpNextConnection = LOCAL_UP_NEXT_CONNECTION
): Promise<void> {
  connection.assertCurrent()
  const subject = view.conversationId
  const source = isUpNextConversation(subject) ? subject : await surface.start?.()
  if (!source) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.subjectNotStarted)
  }
  onStarted(source)
  const current = await readUpNext(subject, connection)
  for (const block of current.blocks) {
    if (
      block.kind !== 'person' ||
      block.state !== 'draft' ||
      !block.receive.createTaskCard ||
      block.receive.attachTaskId
    ) {
      continue
    }
    if (!surface.createCard) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.needsPerson)
    }
    connection.assertCurrent()
    const attachTaskId = await surface.createCard(block, source)
    await writeUpNext(
      subject,
      UP_NEXT_RPC.update,
      {
        blockId: block.id,
        patch: {
          kind: 'person',
          people: block.people.map(({ id, name }) => ({ id, name })),
          receive: { ...block.receive, attachTaskId }
        }
      },
      onRead,
      connection
    )
  }
  let committed: UpNextView | undefined
  let finish: SessionFinishChoice | undefined
  let failure: unknown
  // The commit is the one write that answers with more than the view, so it is called here
  // instead of through `writeUpNext` — which only re-reads. The contract is the same: the
  // host's own view is what the composer shows, refused or not.
  try {
    const answered = await connection.call<{
      view: UpNextView
      finish?: SessionFinishChoice
    }>(UP_NEXT_RPC.commit, {
      conversationId: source,
      ...(isUpNextConversation(subject) ? {} : { adoptFrom: subject })
    })
    finish = answered.finish
  } catch (error) {
    failure = error
  }
  try {
    committed = await readUpNext(source, connection)
  } catch (error) {
    failure ??= error
  }
  if (failure) {
    // A refused old-host call may leave drafts on the original subject.
    if (!isUpNextConversation(subject)) {
      const original = await readUpNext(subject, connection)
      if (original.draftCount > 0) {
        onRead(original)
        throw failure
      }
    }
    if (committed) {
      onRead(committed)
    }
    throw failure
  }
  if (committed) {
    onRead(committed)
  }
  if (!finish) {
    return
  }
  if (!surface.finish) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.doneNeedsWork)
  }
  connection.assertCurrent()
  await surface.finish(finish, source)
}
