/**
 * Monotonic counters for what can reach a conversation while main is judging it: every prompt
 * queue write (enqueue, remove, reorder, sending, settled, cleared) by the queue's row key, and
 * every typed keystroke by PTY. A judgment reads them synchronously before its async work and
 * again after its last await; any change means the facts it read are stale.
 */

let next = 1
const byRowKey = new Map<string, number>()
const byPtyId = new Map<string, number>()

export function bumpConversationMutation(rowKey: string): void {
  byRowKey.set(rowKey, next++)
}

export function bumpPtyInput(ptyId: string): void {
  byPtyId.set(ptyId, next++)
}

export function conversationMutationGeneration(rowKey: string): number {
  return byRowKey.get(rowKey) ?? 0
}

export function ptyInputGeneration(ptyId: string): number {
  return byPtyId.get(ptyId) ?? 0
}
