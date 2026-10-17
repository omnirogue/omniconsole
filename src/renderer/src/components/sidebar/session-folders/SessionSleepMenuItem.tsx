import { Moon, Sunrise } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ledgerOnlyRowRefusal } from '@/lib/mirrored-conversation-row-actions'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { putSidebarSessionToSleep } from '@/lib/put-session-to-sleep'
import {
  isSessionAsleep,
  planCurrentSessionSleep,
  sessionSleepRefusalMessage
} from '@/lib/session-sleep-target'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'

/** One sleep, reported the way the rest of the row's actions report: a toast. */
export async function putSessionToSleepWithToast(session: SidebarSession): Promise<void> {
  const result = await putSidebarSessionToSleep(session)
  if (result.ok) {
    toast.success(translate('conversations.sleep.done', 'Put to sleep'), {
      description: translate(
        'conversations.sleep.doneHint',
        'Open the conversation to resume it where it left off.'
      )
    })
  } else {
    toast.error(translate('conversations.sleep.refused', 'Not put to sleep'), {
      description: result.message
    })
  }
}

/**
 * The row menu's "Put to sleep" (or "Resume" once slept). Read when the menu opens: sleep frees the
 * agent's CPU and memory, and opening the row resumes the same conversation in its pane.
 */
export function SessionSleepMenuItem({
  session,
  onDone
}: {
  session: SidebarSession
  onDone: () => void
}): React.JSX.Element | null {
  // Why (E1/F13): a row the owner's ledger created sleeps and resumes on its owner, not from here;
  // a joined mirror row keeps both (its Resume opens the dormant tab's banner).
  const ledgerRefusal = ledgerOnlyRowRefusal(session)
  if (isSessionAsleep(useAppStore.getState(), session)) {
    return (
      <Button
        variant="ghost"
        size="xs"
        role="menuitem"
        className="w-full justify-start gap-2"
        data-session-row-wake=""
        disabled={ledgerRefusal !== null}
        title={ledgerRefusal ?? undefined}
        onClick={() => {
          onDone()
          openSidebarSession(session)
        }}
      >
        <Sunrise className="size-3.5" />
        {translate('conversations.sleep.resume', 'Resume session')}
      </Button>
    )
  }
  const plan = planCurrentSessionSleep(session)
  // Why: with nothing running there is nothing to sleep, so the item would only be noise.
  if (!plan.ok && (plan.reason === 'not-terminal' || plan.reason === 'no-live-pty')) {
    return null
  }
  const refusal = ledgerRefusal ?? (plan.ok ? null : sessionSleepRefusalMessage(plan.reason))
  return (
    <Button
      variant="ghost"
      size="xs"
      role="menuitem"
      className="w-full justify-start gap-2"
      data-session-row-sleep=""
      disabled={refusal !== null}
      title={refusal ?? undefined}
      onClick={() => {
        onDone()
        void putSessionToSleepWithToast(session)
      }}
    >
      <Moon className="size-3.5" />
      {translate('conversations.sleep.action', 'Put to sleep')}
    </Button>
  )
}
