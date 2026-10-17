import { conversationSourceRowKey } from '../../shared/conversation-source'
import {
  closeWriteFence,
  isWriteFenceOpen,
  openWriteFence
} from '../runtime/conversation-write-fence'
import type { FinishedTurn } from '../next-steps/next-step-turn-signal'
import type { SessionLatestTurn } from './session-manage-freeform'
import type { TransferSession } from './session-manage-transfer-contract'

/**
 * Installed synchronously on the matching finished event, before its wait promise resolves. Keyed by
 * conversation, not sidebar key: a new pane's sidebar key moves to its provider session once known.
 */
export function transferCheckpoints(
  read: (target: TransferSession) => SessionLatestTurn,
  captureExecution: (target: TransferSession) => () => boolean
) {
  const checkpoints = new Map<string, { token: string; holds: () => boolean }>()
  return {
    capture(target: TransferSession, turn: FinishedTurn): void {
      if (
        !target.source ||
        turn.replyComplete !== true ||
        conversationSourceRowKey(target.source) !== conversationSourceRowKey(turn.conversation)
      ) {
        throw new Error('The transfer reply lacks its complete conversation identity.')
      }
      const executionHolds = captureExecution(target)
      const holds = () => {
        const current = read(target)
        return (
          current.known &&
          current.complete &&
          current.turnKey === turn.turnKey &&
          current.text === turn.lastAssistantMessage
        )
      }
      const key = conversationSourceRowKey(target.source)
      const prior = checkpoints.get(key)
      if (prior) {
        closeWriteFence(prior.token)
      }
      checkpoints.set(key, {
        token: openWriteFence(target.source, holds),
        holds: () => executionHolds() && holds()
      })
    },
    assert(targets: TransferSession[]): void {
      for (const target of targets) {
        const proof = target.source
          ? checkpoints.get(conversationSourceRowKey(target.source))
          : undefined
        if (!proof || !isWriteFenceOpen(proof.token) || !proof.holds()) {
          throw new Error(
            `“${target.entry.title}” changed after its transfer reply; no sources were archived.`
          )
        }
      }
    },
    close(): void {
      for (const { token } of checkpoints.values()) {
        closeWriteFence(token)
      }
      checkpoints.clear()
    }
  }
}
