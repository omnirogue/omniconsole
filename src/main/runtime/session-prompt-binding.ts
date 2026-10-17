/**
 * What each prompt `omni session continue|ask` queued is bound to, held in memory: the agent
 * process that must receive it (terminal conversations), and the conversation it was checked
 * against. The queue sends such a prompt only while both still hold, re-proven before
 * every write, Enter included. A restart forgets every binding, so a prompt queued before it fails
 * unsent.
 */

import type { TerminalAgentProcessProof } from './terminal-agent-process'

export type SessionPromptBinding = {
  receiver: TerminalAgentProcessProof | null
  /** Why the prompt must no longer go (its conversation is not what was checked); null when it may. */
  conversationGuard?: () => Promise<string | null>
  /** The same check, synchronous, on what main holds in memory: a changed conversation revokes. */
  conversationStill?: () => boolean
}

const MAX_BINDINGS = 500
const bindings = new Map<string, SessionPromptBinding>()

const keyOf = (rowKey: string, entryId: string): string => `${rowKey}\n${entryId}`

/** Binds a queued entry; the returned function releases it. */
export function bindSessionPrompt(
  rowKey: string,
  entryId: string,
  binding: SessionPromptBinding
): () => void {
  const key = keyOf(rowKey, entryId)
  bindings.delete(key)
  bindings.set(key, binding)
  while (bindings.size > MAX_BINDINGS) {
    bindings.delete(bindings.keys().next().value!)
  }
  return () => {
    if (bindings.get(key) === binding) {
      bindings.delete(key)
    }
  }
}

export function sessionPromptBinding(rowKey: string, entryId: string): SessionPromptBinding | null {
  return bindings.get(keyOf(rowKey, entryId)) ?? null
}

export function releaseSessionPrompt(rowKey: string, entryId: string): void {
  bindings.delete(keyOf(rowKey, entryId))
}
