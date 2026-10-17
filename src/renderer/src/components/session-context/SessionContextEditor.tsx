import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { setSessionContext, useSessionContext } from '@/lib/session-context-store'
import { deliverSessionContext } from '@/lib/session-context-delivery'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { SessionContextItemsEditor } from './SessionContextItemsEditor'

/** A session's (or a launch's) context: saved under `contextKey`, then delivered to `session`. */
export function SessionContextEditor({
  contextKey,
  worktreeId,
  session
}: {
  contextKey: string
  worktreeId: string | null
  session?: SidebarSession
}) {
  const items = useSessionContext(contextKey)
  const [status, setStatus] = useState('')
  const save = async (next: readonly SessionContextAttachment[]) => {
    setStatus('')
    await setSessionContext(contextKey, next)
    if (!session) {
      setStatus(translate('sessionContext.ready', 'Saved for launch.'))
      return
    }
    try {
      const delivery = await deliverSessionContext(session, contextKey)
      setStatus(
        delivery === 'queued'
          ? translate('sessionContext.queued', 'Saved and queued for this session.')
          : translate(
              'sessionContext.nextTurn',
              'Saved. Context will be included in the next chat message.'
            )
      )
    } catch {
      setStatus(
        translate(
          'sessionContext.savedDeliveryFailed',
          'Saved. Delivery could not be confirmed; context remains available for the next chat message.'
        )
      )
    }
  }
  return (
    <SessionContextItemsEditor
      items={items}
      onChange={save}
      worktreeId={worktreeId}
      statusText={status}
    />
  )
}
