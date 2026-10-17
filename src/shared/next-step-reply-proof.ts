import { ASSISTANT_MESSAGE_TRIMMED_MARKER } from './agent-status-field-normalization'
import { sha256 } from './sha256'

export type NextStepReplyPtyProof = {
  turnKey: string
  providerSession: { key: string; id: string }
  replyDigest: string
}

type ReplyPtySource = {
  providerSession?: { key: string; id: string }
  lastAssistantMessage?: string | null
}

/** Owner turn identity and complete reply content survive mirrors without comparing host clocks. */
export function createNextStepReplyPtyProof(
  turnKey: string,
  source: ReplyPtySource
): NextStepReplyPtyProof | null {
  const provider = source.providerSession
  const reply =
    typeof source.lastAssistantMessage === 'string' ? source.lastAssistantMessage.trim() : ''
  if (
    typeof turnKey !== 'string' ||
    !turnKey.trim() ||
    typeof provider?.key !== 'string' ||
    !provider.key.trim() ||
    typeof provider.id !== 'string' ||
    !provider.id.trim() ||
    !reply ||
    reply.includes(ASSISTANT_MESSAGE_TRIMMED_MARKER)
  ) {
    return null
  }
  return {
    turnKey,
    providerSession: { key: provider.key, id: provider.id },
    replyDigest: Array.from(sha256(new TextEncoder().encode(reply)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
  }
}

export function matchesNextStepReplyPtyProof(
  proof: NextStepReplyPtyProof,
  source: ReplyPtySource
): boolean {
  if (!proof || !proof.providerSession) {
    return false
  }
  const current = createNextStepReplyPtyProof(proof.turnKey, source)
  return (
    current !== null &&
    current.providerSession.key === proof.providerSession.key &&
    current.providerSession.id === proof.providerSession.id &&
    current.replyDigest === proof.replyDigest
  )
}
