import { DiscussionWriteBoundary } from './DiscussionWriteBoundary'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  clearMessageOperation,
  recoverMessageOperation,
  retainMessageJoin,
  retainMessageOperation,
  type PeerMessageTarget
} from './next-step-message-recovery'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { emptyNextStepDraft } from '../../../../shared/next-step-draft'
import { NextStepPeopleCard } from './NextStepPersonCard'
import { NextStepSubmitFooter } from './NextStepSubmitFooter'

export type NextStepMessagePanelProps = {
  messageTarget: PeerMessageTarget
  onSent: () => void
}

/** Existing Next Step composer, constrained to the original discussion or message. */
export function NextStepMessagePanel(props: NextStepMessagePanelProps) {
  const scope = useHandoffScope()
  return (
    <DiscussionWriteBoundary key={`${scope}:${props.messageTarget.kind}:${props.messageTarget.id}`}>
      <ScopedMessagePanel {...props} scope={scope} />
    </DiscussionWriteBoundary>
  )
}

function ScopedMessagePanel({
  messageTarget: target,
  onSent,
  scope
}: NextStepMessagePanelProps & { scope: string }) {
  const [recovery] = useState(() => recoverMessageOperation(scope, target))
  const [draft, setDraft] = useState(() => ({
    ...emptyNextStepDraft(),
    note: recovery.pending && 'text' in recovery.pending.body ? recovery.pending.body.text : ''
  }))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [locked, setLocked] = useState(!!recovery.pending)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const isRoom = target.kind === 'room'
  const label = isRoom
    ? t('discussions.post', 'Post to discussion')
    : t('discussions.reply', 'Reply to original message')
  const run = async (join: boolean) => {
    if (busy.current || recovery.error) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const api = consoleWorkflowApi()
      if (join) {
        if (typeof api.joinDiscussion !== 'function') {
          throw new Error(t('discussions.update', 'Update OmniConsole to use discussion actions.'))
        }
        const saved = retainMessageJoin(scope, target)
        workflowData(await api.joinDiscussion(saved.body))
        if (mounted.current) {
          setNotice(t('discussions.joined', 'Joined this discussion.'))
        }
      } else {
        const text = draft.note.trim()
        if (!text || new TextEncoder().encode(text).length > 2048) {
          throw new Error(t('discussions.textLimit', 'Write a message of at most 2 KB.'))
        }
        const saved = retainMessageOperation(scope, target, text)
        setDraft((current) => ({ ...current, note: saved.body.text }))
        setLocked(true)
        if (saved.kind === 'peer-post') {
          if (typeof api.postDiscussion !== 'function') {
            throw new Error(
              t('discussions.update', 'Update OmniConsole to use discussion actions.')
            )
          }
          workflowData(await api.postDiscussion(saved.body))
        } else {
          if (typeof api.replyPeerMessage !== 'function') {
            throw new Error(
              t('discussions.update', 'Update OmniConsole to use discussion actions.')
            )
          }
          workflowData(await api.replyPeerMessage(saved.body))
        }
        clearMessageOperation(scope, target, saved.body.operationId)
        if (mounted.current) {
          setLocked(false)
          setDraft(emptyNextStepDraft())
          setNotice(
            t('discussions.recorded', 'Message recorded. Delivery and replies appear in history.')
          )
          onSent()
        }
      }
    } catch (reason) {
      if (mounted.current) {
        setError(workflowErrorMessage(reason))
      }
    } finally {
      busy.current = false
      if (mounted.current) {
        setPending(false)
      }
    }
  }
  return (
    <div className="space-y-3" data-next-step-message={target.id}>
      <NextStepPeopleCard
        people={[]}
        draft={draft}
        included={target.title}
        taskTitle={null}
        hideTaskContext
        messageOnly
        disabled={pending || locked || !!recovery.error}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
      {isRoom && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !!recovery.error}
          onClick={() => void run(true)}
        >
          {t('discussions.join', 'Join discussion')}
        </Button>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      <NextStepSubmitFooter
        summary={
          locked
            ? t('discussions.retrySame', 'Retry sends the same operation and message.')
            : t(
                'discussions.noOwnership',
                'This message does not transfer ownership or approve work.'
              )
        }
        error={recovery.error || error}
        label={label}
        pending={pending}
        disabled={!draft.note.trim() || !!recovery.error}
        onSend={() => void run(false)}
      />
    </div>
  )
}
