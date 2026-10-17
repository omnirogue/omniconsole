/**
 * The first task for a conversation this host just resumed. Its reply was written before this host
 * watched it, so the next-steps host holds no turn for it and `continue --prompt` would refuse.
 * The transcript itself is read instead: the last finished turn, whole, with the same checks a live
 * reply gets (no proposal, no question at its end, no hard stop). The moment the host sees a turn
 * of its own, that turn is what counts, and the fence it moved revokes the prompt.
 */

import { createHash } from 'node:crypto'
import { isTextBlock, type NativeChatMessage } from '../../shared/native-chat-types'
import { isNoiseMessage } from '../../shared/native-chat-noise'
import type { SessionReferenceAgent } from '../../shared/session-reference'
import { readNativeChatTranscriptTailFile } from '../native-chat/transcript-tail-reader'
import { decodeClaudeTranscriptLine } from '../native-chat/transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from '../native-chat/transcript-line-decoders-codex'
import { nativeChatTurnLifecycleDecoderForAgent } from '../native-chat/transcript-turn-lifecycle'
import { nextStepsFromReply } from '../next-steps/next-step-turn-answers'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import { UNREAD_TURN, type SessionLatestTurn } from './session-manage-freeform'

/** Messages read back from the end; a turn longer than this is not read whole. */
const TAIL_MESSAGES = 80

const text = (message: NativeChatMessage): string =>
  message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()

/** The latest finished turn as its messages hold it: the replies after the last prompt. */
export function latestTurnFromMessages(
  messages: readonly NativeChatMessage[],
  lifecycle: 'working' | 'completed' | 'interrupted' | null
): SessionLatestTurn {
  const unfinished = { ...UNREAD_TURN, known: true }
  if (lifecycle === 'working' || lifecycle === 'interrupted') {
    return unfinished
  }
  const replies: NativeChatMessage[] = []
  for (const message of messages.filter((entry) => !isNoiseMessage(entry)).toReversed()) {
    if (message.role === 'user' && text(message)) {
      const reply = replies.toReversed().map(text).filter(Boolean).join('\n\n')
      const last = replies[0]
      if (!reply || !last) {
        return unfinished
      }
      const steps = nextStepsFromReply(reply)
      return {
        known: true,
        turnKey: `transcript:${createHash('sha256').update(`${last.id}\0${reply}`).digest('hex').slice(0, 32)}`,
        text: reply,
        complete: true,
        proposal: steps.length
          ? JSON.stringify(
              steps.map(({ id, title, prompt, why }) => [id, title, prompt, why ?? null])
            )
          : null,
        empty: false
      }
    }
    if (message.role === 'system') {
      // An interruption marker after the last prompt: that turn never finished.
      return unfinished
    }
    if (message.role === 'assistant') {
      replies.push(message)
    }
  }
  // No prompt within the tail: the turn is longer than what was read, so it is not read whole.
  return unfinished
}

export async function readTranscriptLatestTurn(
  agent: SessionReferenceAgent,
  path: string
): Promise<SessionLatestTurn> {
  const tail = await readNativeChatTranscriptTailFile(
    path,
    TAIL_MESSAGES,
    agent === 'claude' ? decodeClaudeTranscriptLine : decodeCodexTranscriptLine,
    false,
    undefined,
    nativeChatTurnLifecycleDecoderForAgent(agent)
  )
  if (tail.malformedRecordCount || tail.oversizedRecordCount) {
    return { ...UNREAD_TURN, known: true }
  }
  return latestTurnFromMessages(tail.messages, tail.lifecycle?.state ?? null)
}

/**
 * Delivery deps for the first prompt to a just-resumed conversation: while the host holds no turn
 * for it, its latest turn is the transcript's (re-read by every guard); once the host sees one,
 * the host's turn is used and the fence checked against the transcript no longer matches.
 */
export function withTranscriptFirstTurn(
  deps: SessionDeliveryDeps,
  readTranscript: () => Promise<SessionLatestTurn>
): SessionDeliveryDeps {
  let transcript: SessionLatestTurn = UNREAD_TURN
  const hostHoldsNoTurn = (turn: SessionLatestTurn): boolean =>
    turn.known && turn.turnKey === null && !turn.empty
  return {
    ...deps,
    readLatestTurn: async (source) => {
      const host = await deps.readLatestTurn(source)
      if (!hostHoldsNoTurn(host)) {
        return host
      }
      transcript = await readTranscript().catch(() => UNREAD_TURN)
      return transcript
    },
    snapshotLatestTurn: (source) => {
      const host = deps.snapshotLatestTurn(source)
      return hostHoldsNoTurn(host) ? transcript : host
    }
  }
}
