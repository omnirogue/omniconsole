import type { MessageHistoryPort } from './backoffice-message-history'

/** The store's own reads and writes, as the history helper's port. */
type WorkStoreLike = {
  getState: () => {
    scope: string | null
    messagesLoadingMore: boolean
    messagesMore: boolean
  }
  setState: (patch: {
    messages?: { phase: 'ready'; value: Parameters<MessageHistoryPort['ready']>[0] }
    messagesMore?: boolean
    messagesLoadingMore?: boolean
    messagesHistoryError?: string | null
  }) => void
}

/**
 * Built here rather than in the store so `backoffice-work-store` stays under the
 * line ceiling, and takes the store as an argument so this module never imports
 * it back — that import cycle is what the port exists to break.
 */
export function backofficeMessageHistoryPort(store: WorkStoreLike): MessageHistoryPort {
  return {
    snapshot: () => {
      const state = store.getState()
      return {
        scope: state.scope,
        loadingMore: state.messagesLoadingMore,
        hasMore: state.messagesMore
      }
    },
    begin: () => store.setState({ messagesLoadingMore: true, messagesHistoryError: null }),
    ready: (value, hasMore) =>
      store.setState({ messages: { phase: 'ready', value }, messagesMore: hasMore }),
    failed: (messagesHistoryError) => store.setState({ messagesHistoryError }),
    settle: () => store.setState({ messagesLoadingMore: false })
  }
}
