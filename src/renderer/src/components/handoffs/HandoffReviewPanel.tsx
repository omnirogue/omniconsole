import { translate } from '@/i18n/i18n'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  WorkflowTextField,
  WorkflowSelect,
  WorkflowError
} from '@/components/console-workflows/WorkflowFields'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffDetail, ExactHandoffFile } from '../../../../shared/console-handoff-contract'
import { handoffApi } from './handoff-client'
import { HandoffFilePicker } from './HandoffFilePicker'
import {
  clearPendingHandoff,
  recoverPendingHandoff,
  retainPendingHandoff,
  isRejectedHandoff,
  type PendingHandoffRequest
} from './handoff-request-memory'

export function HandoffReviewPanel({
  scope,
  detail,
  onChanged,
  returnOnly = false
}: {
  returnOnly?: boolean
  scope: string
  detail: HandoffDetail
  onChanged: () => void
}) {
  const busy = useRef(false)
  const target = `act:${detail.thread.id}`
  const [recovery] = useState(() => recoverPendingHandoff(scope, target))
  const [retained, setRetained] = useState(recovery.pending)
  const [note, setNote] = useState(retained && 'note' in retained.body ? retained.body.note : '')
  const [file, setFile] = useState<ExactHandoffFile | null>(null)
  const [base, setBase] = useState(retained?.kind === 'return' ? retained.body.baseVersionId : '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const current = detail.files.filter((item) => item.current)
  const canReview = !detail.task_proposal || current.length > 0
  const perform = async (kind: 'approve' | 'request_changes' | 'return') => {
    if (busy.current || !canReview) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    setMessage('')
    try {
      let intent: PendingHandoffRequest | null = retained
      if (!intent) {
        const common = { threadId: detail.thread.id, note, operationId: crypto.randomUUID() }
        if (kind === 'return') {
          if (!file || !base) {
            throw new Error('Choose the version being updated and its replacement file.')
          }
          const { contentBase64: _bytes, ...metadata } = file
          intent = { kind: 'return', body: { ...common, file: metadata, baseVersionId: base } }
        } else {
          intent = {
            kind: 'review',
            body: { ...common, decision: kind, versionIds: current.map((item) => item.id) }
          }
        }
      }
      const saved = retainPendingHandoff(scope, target, intent)
      setRetained(saved)
      if (saved.kind === 'return') {
        if (
          !file ||
          file.sha256 !== saved.body.file.sha256 ||
          file.size !== saved.body.file.size ||
          file.name !== saved.body.file.name
        ) {
          throw new Error('Select the same replacement file to retry this saved request.')
        }
        workflowData(await handoffApi().returnFile({ ...saved.body, file }))
      } else if (saved.kind === 'review') {
        workflowData(await handoffApi().review(saved.body))
      } else {
        throw new Error('This saved request has a different action.')
      }
      clearPendingHandoff(scope, target, saved.body.operationId)
      setRetained(null)
      setFile(null)
      setNote('')
      setMessage(saved.kind === 'return' ? 'Updated file returned.' : 'Review saved.')
      onChanged()
    } catch (reason) {
      if (isRejectedHandoff(reason)) {
        const saved = recoverPendingHandoff(scope, target).pending
        if (saved) {
          clearPendingHandoff(scope, target, saved.body.operationId)
        }
        setRetained(null)
      }
      setError(String(reason instanceof Error ? reason.message : reason))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  if (!canReview) {
    return null
  }
  return (
    <div className="space-y-3 border-t pt-4">
      <WorkflowTextField
        label={translate('handoffs.reviewOrReturnNote185b1', 'Review or return note')}
        value={note}
        onChange={setNote}
        disabled={pending || !!retained}
        multiline
        prose
        maxLength={8192}
      />
      {retained ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'handoffs.aRequestIsSavedFor14824',
            'A request is saved for retry. Its note and exact versions stay fixed.'
          )}
        </p>
      ) : null}
      {(!returnOnly || (retained && retained.kind !== 'return')) && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              pending ||
              !!recovery.error ||
              !note.trim() ||
              (!retained &&
                (current.some((item) => !item.available) || detail.thread.state === 'resolved'))
            }
            onClick={() => void perform('approve')}
          >
            {retained
              ? translate('handoffs.retrySavedAction9b513', 'Retry saved action')
              : translate('handoffs.approveReviewedVersions19cf2', 'Approve reviewed versions')}
          </Button>
          {!retained && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                pending || !!recovery.error || !note.trim() || detail.thread.state === 'resolved'
              }
              onClick={() => void perform('request_changes')}
            >
              {translate('handoffs.requestChangesbbd07', 'Request changes')}
            </Button>
          )}
        </div>
      )}
      {(current.length > 0 || retained?.kind === 'return') && (
        <details open={returnOnly || retained?.kind === 'return'} className="text-sm">
          <summary className="cursor-pointer py-2">
            {translate('handoffs.returnUpdatedFile95d40', 'Return updated file')}
          </summary>
          <div className="space-y-3 py-2">
            <WorkflowSelect
              label={translate('handoffs.versionBeingUpdated432d8', 'Version being updated')}
              value={base}
              onChange={setBase}
              disabled={pending || !!retained}
              options={current
                .filter((item) => item.available)
                .map((item) => ({
                  value: item.id,
                  label: translate('handoffs.fileVersion', '{{name}} · version {{version}}', {
                    name: item.name,
                    version: item.version
                  })
                }))}
            />
            <HandoffFilePicker disabled={pending} onFile={setFile} />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {file.size.toLocaleString()}{' '}
                {translate('handoffs.bytesdaf52', 'bytes')}
              </p>
            )}
            <Button
              size="sm"
              disabled={
                pending ||
                !!recovery.error ||
                (retained !== null && retained.kind !== 'return') ||
                !file ||
                !base ||
                !note.trim()
              }
              onClick={() => void perform('return')}
            >
              {translate('handoffs.returnUpdatedFile95d40', 'Return updated file')}
            </Button>
          </div>
        </details>
      )}
      <WorkflowError message={recovery.error || error} />
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  )
}
