import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { handoffApi } from './handoff-client'
import {
  clearPendingHandoff,
  recoverPendingHandoff,
  retainPendingHandoff,
  isRejectedHandoff,
  type PendingHandoffRequest
} from './handoff-request-memory'

type Decision = 'approve' | 'request_changes'
type Saved = { target: string; request: PendingHandoffRequest }

// Why: Reject was removed, but a `reject-done` retry saved by an older build must still finish.
function recoverDecision(scope: string, detail: HandoffDetail) {
  const threadId = detail.thread.id
  const targets = [`act:${threadId}:reject-done`, `act:${threadId}:decision`]
  const recovered = targets.map((target) => ({ target, ...recoverPendingHandoff(scope, target) }))
  const saved = recovered.find((item) => item.pending)
  const review = detail.reviews.findLast((item) => item.current)
  // Why: a validation-refused completion loses its retry record, but the accepted review remains authoritative.
  const completion: Saved | null =
    detail.thread.state !== 'resolved' &&
    review?.decision === 'request_changes' &&
    review.note?.startsWith('Rejected: ')
      ? {
          target: `act:${threadId}:reject-done`,
          request: {
            kind: 'respond',
            body: {
              threadId,
              kind: 'done',
              note: review.note,
              operationId: crypto.randomUUID()
            }
          }
        }
      : null
  return {
    saved: saved?.pending ? { target: saved.target, request: saved.pending } : completion,
    error: recovered.find((item) => item.error)?.error ?? ''
  }
}

export function useHandoffDecision(scope: string, detail: HandoffDetail, onChanged: () => void) {
  const [recovery] = useState(() => recoverDecision(scope, detail))
  const [saved, setSaved] = useState<Saved | null>(recovery.saved)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const perform = async (decision: Decision, note: string) => {
    if (busy.current || recovery.error) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    // Why: a legacy pending reject completion is only retried, never replaced by a new decision.
    let active: Saved = saved ?? {
      target: `act:${detail.thread.id}:decision`,
      request: {
        kind: 'review',
        body: {
          threadId: detail.thread.id,
          operationId: crypto.randomUUID(),
          decision,
          versionIds: detail.files.filter((file) => file.current).map((file) => file.id),
          note: note.trim() || translate('handoffs.approvedNote0baa5', 'Looks good.')
        }
      }
    }
    try {
      const request = retainPendingHandoff(scope, active.target, active.request)
      active = { ...active, request }
      setSaved(active)
      if (active.request.kind === 'review') {
        workflowData(await handoffApi().review(active.request.body))
      } else if (active.request.kind === 'respond') {
        workflowData(await handoffApi().respond(active.request.body))
      } else {
        throw new Error(
          translate(
            'handoffs.differentSavedActionf155c',
            'This saved request has a different action.'
          )
        )
      }
      clearPendingHandoff(scope, active.target, active.request.body.operationId)
      setSaved(null)
      onChanged()
    } catch (reason) {
      if (isRejectedHandoff(reason)) {
        clearPendingHandoff(scope, active.target, active.request.body.operationId)
        setSaved(null)
      }
      setError(String(reason instanceof Error ? reason.message : reason))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { saved, pending, error: recovery.error || error, blocked: !!recovery.error, perform }
}
