import { conversationSourcesEqual } from '../../../../shared/conversation-source'
import { LOCAL_UP_NEXT_CONNECTION, type UpNextConnection } from './up-next-connection'
import {
  UP_NEXT_RPC,
  isUpNextConversation,
  upNextRowKey,
  type UpNextConversationId,
  type UpNextView
} from '../../../../shared/up-next-types'

export async function readUpNext(
  conversationId: UpNextConversationId,
  connection: UpNextConnection = LOCAL_UP_NEXT_CONNECTION
): Promise<UpNextView> {
  const result = await connection.call<{ view: UpNextView }>(UP_NEXT_RPC.list, {
    conversationId
  })
  const returned = result?.view?.conversationId
  if (
    !returned ||
    upNextRowKey(returned) !== upNextRowKey(conversationId) ||
    (isUpNextConversation(conversationId) &&
      (!isUpNextConversation(returned) || !conversationSourcesEqual(conversationId, returned)))
  ) {
    throw new Error('The execution host answered for a different conversation. Reopen Up next.')
  }
  return result.view
}

/** Every write is followed by a host read, including a refused write. */
export async function writeUpNext(
  conversationId: UpNextConversationId,
  method: string,
  params: Record<string, unknown>,
  onRead: (view: UpNextView) => void,
  connection: UpNextConnection = LOCAL_UP_NEXT_CONNECTION
): Promise<void> {
  let failure: unknown
  try {
    await connection.call(method, { ...params, conversationId })
  } catch (error) {
    failure = error
  }
  try {
    onRead(await readUpNext(conversationId, connection))
  } catch (error) {
    failure ??= error
  }
  if (failure) {
    throw failure
  }
}
