import type { AppState } from '@/store/types'

type AttentionReader = (state: AppState) => ReadonlySet<string>

const NO_ATTENTION: ReadonlySet<string> = new Set()
let attentionReader: AttentionReader | null = null

/**
 * The attention module registers its store reader when it loads, so the closed-sidebar
 * Cmd+1–9 order reads the same attention set without importing that module's heavy chain.
 */
export function registerClosedSidebarAttentionReader(reader: AttentionReader | null): void {
  attentionReader = reader
}

export function readClosedSidebarAttention(state: AppState): ReadonlySet<string> {
  return attentionReader?.(state) ?? NO_ATTENTION
}
