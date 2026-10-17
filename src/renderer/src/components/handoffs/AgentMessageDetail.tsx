import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  communicationLabel,
  communicationExpectationLabel
} from '@/components/native-chat/chat-communication-labels'
import { workflowData } from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'
import type { ChatAgentFile } from '../../../../shared/console-chat-agent-contract'
import { handoffApi, downloadExactHandoffFile } from './handoff-client'

export function AgentMessageDetail({
  scope,
  messageId,
  viewer,
  onChanged
}: {
  scope: string
  messageId: string
  viewer: string | null
  onChanged?: () => void
}) {
  const [thread, setThread] = useState<PeerMessageThread | null>(null)
  const [files, setFiles] = useState<{ messageId: string; file: ChatAgentFile }[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const current = useCallback(
    () => selectConsoleAccountScope(useAppStore.getState()) === scope,
    [scope]
  )
  useEffect(() => {
    let live = true
    const load = async () => {
      setError('')
      try {
        const opened = workflowData(await handoffApi().getAgentMessage({ messageId })).thread
        if (!live || !current()) {
          return
        }
        setThread(opened)
        const detail = workflowData(await handoffApi().readAgentMessage({ messageId })).thread
        if (!live || !current()) {
          return
        }
        setThread(detail)
        const manifests: { messageId: string; file: ChatAgentFile }[] = []
        for (const id of [messageId, ...(detail.reply ? [detail.reply.id] : [])]) {
          if (!live || !current()) {
            return
          }
          const result = workflowData(await handoffApi().agentMessageFiles({ messageId: id }))
          manifests.push(...result.files.map((file) => ({ messageId: id, file })))
        }
        if (live && current()) {
          setFiles(manifests)
        }
      } catch (cause) {
        if (live && current()) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [messageId, current, revision])
  const download = async (id: string, file: ChatAgentFile) => {
    try {
      if (!current()) {
        return
      }
      const exact = workflowData(await handoffApi().downloadAgentFile({ messageId: id, file }))
      if (current()) {
        downloadExactHandoffFile(exact)
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }
  const complete = async () => {
    if (pending || !current()) {
      return
    }
    setPending(true)
    try {
      workflowData(await handoffApi().resolveAgentMessage({ messageId }))
      if (current()) {
        setRevision((value) => value + 1)
        onChanged?.()
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (current()) {
        setPending(false)
      }
    }
  }
  return (
    <div className="space-y-3" data-agent-message={messageId}>
      <WorkflowError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        {thread && <Badge variant="outline">{thread.state}</Badge>}
        {thread?.communication_type && (
          <Badge variant="secondary">{communicationLabel(thread.communication_type)}</Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setRevision((value) => value + 1)}
        >
          {translate('handoffs.refresh56e3b', 'Refresh')}
        </Button>
      </div>
      {!thread && (
        <p className="text-xs text-muted-foreground">
          {translate('chatDelivery.loadingMessage', 'Loading message…')}
        </p>
      )}
      {thread && (
        <>
          <CommentMarkdown content={thread.summary} className="text-sm" />
          {thread.communication_type && (
            <p className="text-xs text-muted-foreground">
              {communicationExpectationLabel(thread.communication_type)}
            </p>
          )}
          {thread.reply && (
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                {translate('chatDelivery.reply', 'Reply')} ·{' '}
                {new Date(thread.reply.created_at * 1000).toLocaleString()}
              </p>
              <CommentMarkdown content={thread.reply.summary} className="text-sm" />
            </div>
          )}
          {files.map(({ messageId: id, file }) => (
            <div key={`${id}:${file.id}`} className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                {file.name} · {file.size.toLocaleString()}{' '}
                {translate('handoffs.bytesdaf52', 'bytes')} ·{' '}
                {translate('chatDelivery.version', 'Version')} {file.sha256.slice(0, 8)}
              </span>
              <Button size="xs" variant="outline" onClick={() => void download(id, file)}>
                {translate('handoffs.downloada479c', 'Download')}
              </Button>
            </div>
          ))}
          {thread.state === 'replied' &&
            thread.sender_employee_id === viewer &&
            thread.task_id === null && (
              <Button size="sm" disabled={pending} onClick={() => void complete()}>
                {translate('chatActions.complete', 'Complete')}
              </Button>
            )}
        </>
      )}
    </div>
  )
}
