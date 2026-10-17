import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffReceiveSummary } from '../../../../shared/console-handoff-contract'
import { handoffApi } from './handoff-client'
import {
  clearPendingHandoff,
  recoverPendingHandoff,
  retainPendingHandoff,
  isRejectedHandoff,
  type PendingHandoffRequest
} from './handoff-request-memory'

export function handoffFileOutcomeCounts(summary: HandoffReceiveSummary) {
  return summary.files.files.reduce(
    (counts, file) => {
      counts[file.outcome] += 1
      return counts
    },
    { written: 0, unchanged: 0, refused: 0 }
  )
}

export function useHandoffTransfer(scope: string, threadId: string) {
  const target = `act:${threadId}:save-files`
  const [recovery] = useState(() => recoverPendingHandoff(scope, target))
  const [saved, setSaved] = useState({ save: recovery.pending })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const busy = useRef(false)
  const blocked = !!recovery.error
  const perform = async (kind: 'save') => {
    if (busy.current || blocked) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    setMessage('')
    let active: PendingHandoffRequest | null = saved[kind]
    try {
      if (!active) {
        const workspacePath = await window.api.repos.pickFolder()
        if (!workspacePath) {
          return
        }
        active = {
          kind: 'materialize',
          body: { threadId, workspacePath, filesOnly: true, operationId: crypto.randomUUID() }
        }
      }
      active = retainPendingHandoff(scope, target, active)
      setSaved((value) => ({ ...value, [kind]: active }))
      if (active.kind === 'materialize') {
        // Materialize has no wire operation ID; exact destinations and content checks make retries safe.
        const { operationId: _operationId, ...request } = active.body
        const summary = workflowData(await handoffApi().materialize(request))
        setMessage(
          translate(
            'handoffs.filesSavedCounts',
            '{{written}} written · {{unchanged}} unchanged · {{refused}} refused',
            handoffFileOutcomeCounts(summary)
          )
        )
      } else {
        throw new Error(
          translate(
            'handoffs.differentSavedActionf155c',
            'This saved request has a different action.'
          )
        )
      }
      clearPendingHandoff(scope, target, active.body.operationId)
      setSaved((value) => ({ ...value, [kind]: null }))
    } catch (reason) {
      if (active && isRejectedHandoff(reason)) {
        clearPendingHandoff(scope, target, active.body.operationId)
        setSaved((value) => ({ ...value, [kind]: null }))
      }
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return {
    saved,
    pending,
    blocked,
    error: recovery.error || error,
    message,
    perform
  }
}
