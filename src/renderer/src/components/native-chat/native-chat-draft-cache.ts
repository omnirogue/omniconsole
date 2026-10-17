import {
  clearNativeChatComposerStorageForTests,
  readNativeChatComposerStorage,
  writeNativeChatComposerStorage
} from './native-chat-composer-storage'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const draftCache = new Map<string, string>()

export function readNativeChatDraftCache(scopeKey: string): string {
  return draftCache.get(scopeKey) ?? readNativeChatComposerStorage<string>('text', scopeKey) ?? ''
}

export function writeNativeChatDraftCache(scopeKey: string, draft: string): void {
  writeNativeChatComposerStorage('text', scopeKey, draft || undefined)
  // An empty draft carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared text.
  if (draft === '') {
    draftCache.delete(scopeKey)
    return
  }
  // LRU-bounded so unsent drafts for permanently-removed panes can't accumulate.
  setBoundedScopeCacheEntry(draftCache, scopeKey, draft)
}

export function clearNativeChatDraftCacheForTests(): void {
  draftCache.clear()
  clearNativeChatComposerStorageForTests('text')
}
