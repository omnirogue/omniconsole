import type { NativeChatMessage } from '../../../shared/native-chat-types'

export type SessionPaneChatController = {
  writable: boolean
  needsYou: number
  messages: readonly NativeChatMessage[]
  send: (text: string) => boolean
}
const controllers = new Map<string, { owner: symbol; value: SessionPaneChatController }>()
const listeners = new Map<string, Set<() => void>>()

export function sessionPaneChatKey(
  hostId: string | null,
  worktreeId: string,
  tabId: string
): string {
  return JSON.stringify([hostId, worktreeId, tabId])
}
export function getSessionPaneChatController(key: string): SessionPaneChatController | null {
  return controllers.get(key)?.value ?? null
}
export function subscribeSessionPaneChatController(key: string, listener: () => void): () => void {
  const bucket = listeners.get(key) ?? new Set()
  listeners.set(key, bucket)
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (!bucket.size) {
      listeners.delete(key)
    }
  }
}
export function publishSessionPaneChatController(
  key: string,
  owner: symbol,
  value: SessionPaneChatController
): void {
  controllers.set(key, { owner, value })
  listeners.get(key)?.forEach((listener) => listener())
}
export function removeSessionPaneChatController(key: string, owner: symbol): void {
  if (controllers.get(key)?.owner !== owner) {
    return
  }
  controllers.delete(key)
  listeners.get(key)?.forEach((listener) => listener())
}
