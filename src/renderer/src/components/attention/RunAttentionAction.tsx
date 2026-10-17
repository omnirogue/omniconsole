import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { UpNextPopover } from '@/components/next-action/UpNextPopover'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { HumanAttentionRequest } from '../../../../shared/session-human-attention'
import type { AttentionPane, RunAttention } from './agent-pane-snapshot'
import { openAttentionPaneInWorkspace } from './attention-actions'

type ActionKind = NonNullable<HumanAttentionRequest['action']>['kind']

/** The button's words are this app's, by kind; the ask beside it is the host's own sentence. */
export function runAttentionActionLabel(kind: ActionKind): string {
  switch (kind) {
    case 'open-conversation':
      return translate('conversations.requestOpenConversation', 'Open conversation')
    case 'review-outcome':
      return translate('conversations.requestReview', 'Review')
    case 'open-up-next':
      return translate('conversations.requestOpenUpNext', 'Open Up next')
    case 'sign-in':
      return translate('conversations.requestSignIn', 'Sign in')
  }
}

/** Lands on the pane that asks, through the same door every "needs you" pane opens by. */
function openConversation(pane: AttentionPane): void {
  // Why: a run carries on with its conversation closed; then there is no pane to land on.
  if (!pane.tabId || !openAttentionPaneInWorkspace(pane)) {
    toast.error(
      translate('work.openSessionFailed', 'This session could not be opened; check its workspace.')
    )
  }
}

/**
 * The direct way to meet a run's request: the conversation that asks, that conversation's Up
 * next, or the accounts page. Going there resolves nothing; only the requirement being met does.
 */
export function RunAttentionAction({
  pane,
  run,
  sessions
}: {
  pane: AttentionPane
  run: RunAttention
  sessions: readonly SidebarSession[]
}): React.JSX.Element | null {
  const action = run.requests[0]?.action
  if (!action) {
    return null
  }
  const owner = sessions.find((session) => session.rowKey === run.sourceRowKey) ?? null
  const label = runAttentionActionLabel(action.kind)
  if ((action.kind === 'review-outcome' || action.kind === 'open-up-next') && owner) {
    return (
      <span data-run-attention-action={action.kind}>
        <UpNextPopover subject={{ kind: 'session', session: owner }} triggerContent={label} />
      </span>
    )
  }
  return (
    <Button
      size="xs"
      variant="outline"
      data-run-attention-action={action.kind}
      onClick={() => {
        if (action.kind === 'sign-in') {
          useAppStore.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
          useAppStore.getState().openSettingsPage()
          return
        }
        openConversation(pane)
      }}
    >
      {label}
    </Button>
  )
}
