/**
 * Before a continued step refuses because its conversation is gone (rule 1 of the same-session
 * route), a waiting conversation that EXITED gets one chance to come back: the steward resumes it
 * (`steward-waiter-resume.ts`, through #751's `resumeConversation`) and the step is delivered into
 * the resumed pane, or it reads Stalled with the reason it could not be resumed.
 *
 * Installed at startup; with nothing installed the route behaves exactly as before.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

export type SameConversationRevival =
  | { kind: 'resumed'; source: ConversationSource }
  | { kind: 'stalled'; reason: string }

type Reviver = (
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  source: ConversationSource | null
) => Promise<SameConversationRevival | null>

let reviver: Reviver | null = null

export function installSameConversationReviver(next: Reviver | null): () => void {
  const previous = reviver
  reviver = next
  return () => {
    reviver = previous
  }
}

/** Null when the conversation needs nothing (live, unreadable, or not a waiting plan). */
export async function reviveSameConversation(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  source: ConversationSource | null
): Promise<SameConversationRevival | null> {
  if (!reviver) {
    return null
  }
  try {
    return await reviver(runtime, chain, source)
  } catch (error) {
    return {
      kind: 'stalled',
      reason: `Stalled: the waiting session could not be resumed (${error instanceof Error ? error.message : String(error)}).`
    }
  }
}

/**
 * A resumed agent sits at its prompt with no finished turn to name, so the turn is delivered after
 * this marker instead; the NEXT real ending, whatever its identity, is the one that settles it.
 */
const RESUMED_TURN_PREFIX = 'resumed:'

export function resumedTurnVersion(paneKey: string): string {
  return `${RESUMED_TURN_PREFIX}${paneKey}`
}

export function isResumedTurnVersion(version: string | undefined): boolean {
  return Boolean(version?.startsWith(RESUMED_TURN_PREFIX))
}
