import { translate } from '@/i18n/i18n'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { downloadHandoffVersion, handoffApi } from './handoff-client'
import { HandoffReviewPanel } from './HandoffReviewPanel'
import { HandoffFiles } from './HandoffFiles'
import { handoffPackageOf } from '../../../../shared/console-handoff-disposition-reference'
import { HandoffDescriptionSection } from './HandoffDescriptionSection'
import { HandoffTranscriptSection } from './HandoffTranscriptSection'
import { HandoffDecisionBar, HandoffDecisionStatus } from './HandoffDecisionBar'
import { canDecideHandoff, canStartHandoff } from './handoff-review-decision'
import { HandoffSessionButton } from './HandoffSessionButton'
import { HandoffCommunicationReply } from './HandoffCommunicationReply'
import { HandoffTaskTracking } from './HandoffTaskTracking'
import { communicationLabel } from '@/components/native-chat/chat-communication-labels'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useHandoffRosterNames } from './useHandoffRosterNames'

/** What changed: the thread was read on open, or updated by a review, return or forward. */
export type HandoffChange = 'read' | 'updated'

export function HandoffDetailView({
  scope,
  threadId,
  markRead = true,
  viewer = null,
  onOpenTask,
  onChanged
}: {
  scope: string
  threadId: string
  /** Mark the thread read on open; false for a thread shown by default rather than chosen. */
  markRead?: boolean
  /** The signed-in employee; only the recipient may start the handoff with their AI. */
  viewer?: string | null
  /** Show the thread's card: the caller decides where (its row, or the Console). */
  onOpenTask?: (taskId: string) => void
  /** Called after each change that succeeded, so lists counting this thread can re-read. */
  onChanged?: (change: HandoffChange) => void
}) {
  const replyRef = useRef<HTMLDivElement>(null)
  const personName = useHandoffRosterNames(scope)
  const [detail, setDetail] = useState<HandoffDetail | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const readSucceeded = useEffectEvent(() => onChanged?.('read'))
  useEffect(() => {
    let live = true
    setError('')
    void Promise.resolve()
      .then(() => handoffApi().get({ threadId }))
      .then((result) => {
        if (live) {
          setDetail(workflowData(result))
          // Why: a thread only shown by default was not opened by the person, so it stays unread.
          if (!markRead) {
            return
          }
          void handoffApi()
            .markRead({ threadId })
            .then((read) => {
              if (live) {
                setDetail(workflowData(read))
                readSucceeded()
              }
            })
            .catch((reason) => {
              if (live) {
                setError(String(reason.message ?? reason))
              }
            })
        }
      })
      .catch((reason) => {
        if (live) {
          setError(String(reason.message ?? reason))
        }
      })
    return () => {
      live = false
    }
  }, [threadId, revision, markRead])
  const download = async (file: HandoffDetail['files'][number]) => {
    try {
      await downloadHandoffVersion(threadId, file)
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason))
    }
  }
  const parts = detail ? handoffPackageOf(detail) : null
  // Why: the roster read falls back to the raw employee id; the header prose needs a plain word instead.
  const senderName = (id: string) => {
    const name = personName(id)
    return name === id ? translate('handoffs.theSender', 'The sender') : name
  }
  const updated = () => {
    setRevision((value) => value + 1)
    onChanged?.('updated')
  }
  return (
    <div className="space-y-4">
      <WorkflowError message={error} />
      {!detail ? (
        <p className="text-sm text-muted-foreground">
          {translate('handoffs.loadingRequestd3262', 'Loading request…')}
        </p>
      ) : (
        <>
          <h1 className="text-sm font-semibold">{detail.thread.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{detail.thread.state}</Badge>
            {detail.thread.communication_type ? (
              <Badge variant="outline">
                {communicationLabel(detail.thread.communication_type)}
              </Badge>
            ) : (
              !parts?.disposition &&
              detail.thread.action && <Badge variant="outline">{detail.thread.action}</Badge>
            )}
            {!detail.thread.task_ref && detail.thread.board_task_id && onOpenTask ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenTask(detail.thread.board_task_id!)}
              >
                {translate('handoffs.openTaska1f17', 'Open task')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
              {translate('handoffs.refresh56e3b', 'Refresh')}
            </Button>
          </div>
          <p className="text-sm">
            {parts?.disposition === 'feedback'
              ? translate('handoffs.waitingForYourOk', '{{sender}} is waiting for your OK.', {
                  sender: senderName(detail.thread.author_employee_id)
                })
              : parts?.disposition === 'ownership-transfer'
                ? translate('handoffs.gaveYouThis', "{{sender}} gave you this. It's yours now.", {
                    sender: senderName(detail.thread.author_employee_id)
                  })
                : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {personName(detail.thread.author_employee_id)} →{' '}
            {personName(detail.thread.recipient_employee_id)}
            {detail.thread.due_at &&
              translate('handoffs.dueDate517a0', ' · Due {{date}}', {
                date: new Date(detail.thread.due_at).toLocaleString()
              })}
          </p>
          {canDecideHandoff(detail, viewer) && (
            <HandoffDecisionBar
              key={`${scope}:${threadId}`}
              scope={scope}
              detail={detail}
              onChanged={updated}
              onReply={() => {
                replyRef.current?.scrollIntoView({ block: 'nearest' })
                replyRef.current?.querySelector<HTMLElement>('textarea, input')?.focus()
              }}
            />
          )}
          <HandoffDecisionStatus detail={detail} />
          <HandoffTaskTracking detail={detail} />
          {detail.task_proposal && canStartHandoff(detail, viewer) && (
            <HandoffSessionButton detail={detail} mode="continue" />
          )}
          <HandoffDescriptionSection detail={detail} summary={parts?.summary ?? null} />
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {translate('handoffs.files6ce6c', 'Files')}
            </h2>
            {parts?.work.length ? (
              <HandoffFiles threadId={threadId} files={parts.work} onDownload={download} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {translate('handoffs.noWorkFilesb433b', 'No work files were attached.')}
              </p>
            )}
            {detail.thread.state !== 'resolved' &&
            (!detail.task_proposal || detail.files.some((file) => file.current)) &&
            (!detail.thread.communication_type || detail.files.length > 0) ? (
              <details className="text-sm">
                <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
                  {detail.task_proposal
                    ? translate('handoffs.reviewOrReturnFiles', 'Review or return files')
                    : translate('handoffs.returnAnUpdatedFile9d073', 'Return an updated file')}
                </summary>
                <HandoffReviewPanel
                  key={`${scope}:${threadId}`}
                  returnOnly={!detail.task_proposal}
                  scope={scope}
                  detail={detail}
                  onChanged={updated}
                />
              </details>
            ) : null}
          </section>
          {parts?.transcript && (
            <HandoffTranscriptSection
              detail={detail}
              file={parts.transcript}
              canStart={canStartHandoff(detail, viewer)}
              onDownload={download}
            />
          )}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {translate('handoffs.conversation2a20c', 'Conversation')}
            </h2>
            {detail.entries
              .slice(Math.max(0, detail.entries.findIndex((entry) => entry.kind === 'handoff') + 1))
              .map((entry) => (
                <div key={entry.id} className="space-y-1 border-b pb-3">
                  <CommentMarkdown content={entry.body} className="text-sm" />
                  <p className="text-xs text-muted-foreground">
                    {entry.kind} · {new Date(entry.created).toLocaleString()}
                  </p>
                </div>
              ))}
            <div ref={replyRef}>
              <HandoffCommunicationReply
                key={`${scope}:${threadId}`}
                scope={scope}
                detail={detail}
                viewer={viewer}
                onChanged={updated}
              />
            </div>
          </section>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {translate('handoffs.versionHistoryAndDetails078c6', 'Version history and details')}
            </summary>
            <div className="space-y-2 pt-2">
              {detail.thread.task_ref ? (
                <p>{detail.thread.task_ref.issue_key}</p>
              ) : detail.thread.board_task_id ? (
                <p>
                  {translate('handoffs.task6f0e9', 'Task ')}
                  {detail.thread.board_task_id}
                </p>
              ) : (
                <p>{translate('handoffs.noTask', 'Not on a task; it is the request itself.')}</p>
              )}
              <p>
                {personName(detail.thread.author_employee_id, true)} →{' '}
                {personName(detail.thread.recipient_employee_id, true)}
              </p>
              {detail.thread.delivery_id && (
                <p>
                  {translate('handoffs.deliveryReceipt9dddd', 'Delivery receipt: ')}
                  {detail.thread.delivery_id}
                </p>
              )}
              {detail.files.map((file) => (
                <div key={file.id} className="break-all">
                  <p>
                    {file.name} {translate('handoffs.version88b19', '· version ')}
                    {file.version}
                  </p>
                  <p className="font-mono">{file.sha256}</p>
                  {!file.current && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!file.available}
                      onClick={() => void download(file)}
                    >
                      {translate('handoffs.downloadThisVersionce2e2', 'Download this version')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  )
}
