import type { ComponentProps } from 'react'
import { useAppStore } from '@/store'
import {
  updateConversationLaunchDraft,
  useConversationLaunchDrafts
} from '@/lib/conversation-launch-draft'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import TerminalPane from './TerminalPane'
import { LocalWorkflowConversation } from '../local-workflows/LocalWorkflowConversation'

/** Both terminal surface models stop here before any PTY lifecycle hooks mount. */
export default function ConversationTerminalPane(
  props: ComponentProps<typeof TerminalPane>
): React.JSX.Element | null {
  const pending = useAppStore((state) =>
    state.tabsByWorktree[props.worktreeId]?.some(
      (tab) => tab.id === props.tabId && tab.conversationLaunchPending
    )
  )
  const draft = useConversationLaunchDrafts((state) => state.drafts[props.tabId])
  const workflowTab = useAppStore((state) =>
    state.tabsByWorktree[props.worktreeId]?.find(
      (tab) => tab.id === props.tabId && tab.localWorkflow
    )
  )
  if (workflowTab) {
    return props.isVisible === false ? null : (
      <LocalWorkflowConversation tab={workflowTab} onClose={props.onCloseTab} />
    )
  }
  if (!pending) {
    return <TerminalPane {...props} />
  }
  if (props.isVisible === false) {
    return null
  }
  return (
    <section
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6"
      aria-label={translate('conversations.newConversation', 'New conversation')}
      data-conversation-launch-draft={props.tabId}
    >
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">
            {translate('conversations.newConversation', 'New conversation')}
          </h2>
          <Button size="sm" variant="ghost" onClick={() => props.onCloseTab?.()}>
            {translate('conversations.closeDraft', 'Close')}
          </Button>
        </div>
        <p
          className="text-sm text-muted-foreground"
          role={!draft || draft.status === 'failed' ? 'alert' : 'status'}
        >
          {!draft
            ? translate(
                'conversations.expiredDraft',
                'This conversation could not be restored. Close it and start a new conversation.'
              )
            : (draft.error ??
              (draft.status === 'launching'
                ? translate('conversations.openingAgent', 'Opening your agent…')
                : translate(
                    'conversations.preparingDraft',
                    'Checking available agents. You can write your request now.'
                  )))}
        </p>
        <Textarea
          autoFocus={props.isActive}
          className="min-h-40"
          aria-label={translate('conversations.requestDraft', 'Request draft')}
          placeholder={translate(
            'conversations.requestPlaceholder',
            'What would you like to work on?'
          )}
          value={draft?.text ?? ''}
          readOnly={!draft || draft.status === 'launching'}
          onChange={(event) =>
            updateConversationLaunchDraft(props.tabId, { text: event.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'conversations.draftNotSent',
            'Your request stays editable when the agent opens. Close this conversation to cancel before it starts.'
          )}
        </p>
      </div>
    </section>
  )
}
