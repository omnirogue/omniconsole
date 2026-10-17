import { translate } from '@/i18n/i18n'
import { upNextAddressForPane } from '@/lib/conversation-source-for-pane'
import { sessionPrepProjectFolderForPane } from '@/lib/session-prep-project-folder'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { detectConversationalDispatchRequest } from '../../../../shared/session-dispatch-intent'
import { SESSION_PREP_RPC } from '../../../../shared/session-prep-types'
import { consumeSessionPrepUndoBypass, noteSessionPrepBatch } from './session-prep-composer-state'

export type SessionPrepCommandArgs = {
  paneKey: string
  tabId: string
  agent: string
  getContext: () => string
  automaticDispatch?: boolean
  setDraft: (value: string) => void
  report: (notice: string) => void
}

function failureReason(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error)
}

/**
 * Routes a new human objective through preparation while keeping follow-ups in this conversation.
 */
export function useSessionPrepCommand({
  paneKey,
  tabId,
  agent,
  getContext,
  automaticDispatch = true,
  setDraft,
  report
}: SessionPrepCommandArgs): (text: string) => boolean {
  return (text) => {
    const context = getContext()
    const detected = detectConversationalDispatchRequest(text, context, automaticDispatch)
    if (!detected) {
      return false
    }
    if (consumeSessionPrepUndoBypass(paneKey, text)) {
      return false
    }
    const address = upNextAddressForPane(paneKey, tabId)
    if (!address || address.owner.kind !== 'local') {
      return false
    }
    const defaultFolder = sessionPrepProjectFolderForPane(paneKey, tabId)
    setDraft('')
    noteSessionPrepBatch(paneKey)
    void callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.request, {
      text: detected.request,
      source: {
        worktreeId: address.source.worktreeId,
        paneKey: address.source.paneKey,
        agent
      },
      context,
      // Why only inside a project: the request schema is strict, and the key means "file it here".
      ...(defaultFolder ? { defaultFolder } : {})
    }).then(
      () => undefined,
      (error: unknown) => {
        setDraft(text)
        report(
          translate('sessionPrep.requestFailed', 'Could not start preparing sessions: {{reason}}', {
            reason: failureReason(error)
          })
        )
      }
    )
    return true
  }
}
