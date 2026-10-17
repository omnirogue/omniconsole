import { useEffect } from 'react'
import { toast } from 'sonner'

import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { openLinkedSession } from '@/lib/open-linked-session'
import type { BackofficeOpenTarget } from '../../../shared/backoffice-task-link'
import { useAppStore } from '../store'

/**
 * Surfaces new backoffice task assignments (main-process poller) as toasts.
 * v1 delivery: in-app toast; a native-notification source type is a later,
 * settings-integrated upgrade.
 */
export function useBackofficeAssignmentToasts(): void {
  useEffect(() => {
    return window.api.backoffice.onAssignments((event) => {
      for (const item of event.items) {
        toast(translate('auto.hooks.backofficeAssignment.title', 'New task assigned to you'), {
          description: `${item.task_id} — ${item.title}${
            item.company_slug ? ` · ${item.company_slug}` : ''
          }`
        })
      }
    })
  }, [])
}

/** omni://backoffice/task/<id> and omni://backoffice/thread/<id> deep links: open the
 * Work list and ask it to select that card or thread — selection only, nothing
 * auto-runs (any page can fire the scheme). omni://backoffice/session/<id> opens that session. */
export function useBackofficeDeepLinks(): void {
  useEffect(() => {
    let disposed = false
    let pending: BackofficeOpenTarget | null = null
    const showTarget = (target: BackofficeOpenTarget): void => {
      if (disposed) {
        return
      }
      if ('sessionLedgerId' in target) {
        openLinkedSession(target)
        return
      }
      const state = useAppStore.getState()
      // Why: the request is bound to the signed-in scope, so another account's list never answers it.
      useBackofficeWorkFocus
        .getState()
        .focus({ scope: selectConsoleAccountScope(state), ...target })
      state.openTaskPage({ taskSource: 'backoffice' })
    }
    // Cold start: the link may have arrived before this listener existed —
    // and startup hydration overwrites activeView (hydratePersistedUI,
    // source 'startup'), so wait for persistedUIReady before navigating.
    const unsubscribeHydration = useAppStore.subscribe((state) => {
      if (disposed || !state.persistedUIReady || pending === null) {
        return
      }
      const target = pending
      pending = null
      unsubscribeHydration()
      showTarget(target)
    })
    // Strict Mode discards the first effect before this destructive read should run.
    void Promise.resolve()
      .then(() => (disposed ? null : window.api.backoffice.consumePendingOpenTask()))
      .then((target) => {
        if (disposed) {
          return
        }
        if (!target) {
          unsubscribeHydration()
          return
        }
        if (useAppStore.getState().persistedUIReady) {
          unsubscribeHydration()
          showTarget(target)
          return
        }
        pending = target
      })
    const unsubscribeOpenTask = window.api.backoffice.onOpenTask(showTarget)
    return () => {
      disposed = true
      pending = null
      unsubscribeHydration()
      unsubscribeOpenTask()
    }
  }, [])
}
