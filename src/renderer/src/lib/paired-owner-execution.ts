import {
  ownerPublishesMirroredConversationLedger,
  type MirroredConversationOwner
} from '@/store/slices/mirrored-conversation-ledger'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'

/**
 * Addendum C4/F10: whether a paired OmniConsole executes this row's conversation, so this computer
 * never resumes or wakes it (the owner does; the receiver waits). The evidence is execution-owner
 * evidence from the owner itself, never `hostId === 'local'` alone: a row its ledger vouches for,
 * or any row under a runtime whose owner publishes a ledger. Local and direct-SSH rows keep their
 * routed resume; a runtime with no ledger (an older owner, a headless runtime this window drives)
 * keeps today's behaviour.
 */
export function isPairedOwnerConversation(
  owners: Readonly<Record<string, MirroredConversationOwner>> | undefined,
  row: { hostId: string | null; mirroredConversation?: MirroredSidebarConversation }
): boolean {
  if (row.mirroredConversation) {
    return true
  }
  const host = parseExecutionHostId(row.hostId)
  return (
    host?.kind === 'runtime' &&
    ownerPublishesMirroredConversationLedger(owners?.[host.environmentId])
  )
}
