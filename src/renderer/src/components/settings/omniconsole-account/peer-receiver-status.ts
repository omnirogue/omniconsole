import { z } from 'zod'
import { translate as t } from '@/i18n/i18n'

export const ReceiverResponse = z.object({
  receiver: z
    .object({
      phase: z.string(),
      reason: z.string().optional(),
      lastPendingCheckAt: z.number().finite().nonnegative().optional(),
      consecutiveFailures: z.number().int().nonnegative().optional(),
      nextCheckAt: z.number().finite().nonnegative().optional(),
      pending: z.object({ pending: z.number().int().nonnegative() }).optional(),
      enrollment: z
        .object({
          projectId: z.string(),
          taskId: z.string(),
          peerSessionId: z.string(),
          provider: z.string()
        })
        .optional()
    })
    .nullable()
})
export type PeerReceiverStatus = z.infer<typeof ReceiverResponse>['receiver']

export function receiverLabel(status: PeerReceiverStatus): string {
  if (!status) {
    return t('inbox.receiverUnbound', 'No automatic receiver is attached')
  }
  switch (status.phase) {
    case 'idle':
      return t('inbox.receiverListening', 'Listening for pending work')
    case 'polling':
    case 'loading':
      return t('inbox.receiverChecking', 'Checking receiver')
    case 'busy':
    case 'input':
      return t('inbox.receiverWaiting', 'Waiting for a safe checkpoint')
    case 'consent':
      return t('inbox.receiverConsent', 'Automatic reception needs owner consent')
    case 'awaiting-completion':
      return t('inbox.receiverQueued', 'Native hint queued; model completion pending')
    case 'uncertain':
      return t('inbox.receiverUncertain', 'Previous attempt unresolved; no automatic resend')
    case 'error':
      return t('inbox.receiverError', 'Receiver check failed')
    case 'revoked':
      return t('inbox.receiverRevoked', 'Conversation binding is no longer valid')
    case 'stopped':
      return t('inbox.receiverStopped', 'Receiver stopped')
    case 'persisting':
    case 'submitting':
      return t('inbox.receiverSubmitting', 'Preparing one native hint')
    default:
      return t('inbox.receiverUnknown', 'Unknown receiving state; update or inspect the runtime')
  }
}
