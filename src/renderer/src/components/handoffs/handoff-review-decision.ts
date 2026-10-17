import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { handoffPackageOf } from '../../../../shared/console-handoff-disposition-reference'
import { isThreadRecipient } from '@/components/next-step/next-step-subject'

export function canDecideHandoff(detail: HandoffDetail, viewer: string | null): boolean {
  return !detail.task_proposal && canStartHandoff(detail, viewer)
}

export function canStartHandoff(detail: HandoffDetail, viewer: string | null): boolean {
  return (
    !detail.thread.communication_type &&
    detail.thread.state !== 'resolved' &&
    isThreadRecipient({ kind: 'thread', detail, viewer })
  )
}

export function isHandoffReview(detail: HandoffDetail): boolean {
  const disposition = handoffPackageOf(detail).disposition
  return (
    disposition === 'feedback' ||
    (disposition === null && ['review', 'approve', 'decide'].includes(detail.thread.action ?? ''))
  )
}

export function handoffDecision(detail: HandoffDetail): 'approve' | 'request_changes' | null {
  const current = detail.reviews.filter((review) => review.current)
  return current.at(-1)?.decision ?? null
}
