import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  loadBackofficeWork,
  useBackofficeWorkStore,
  type TodoFeed,
  type WorkLoad
} from '../backoffice/backoffice-work-store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { requestFloatingTerminalOpen } from '@/lib/floating-terminal'
import { resolveBackofficeBaseUrl } from '../../../../../shared/backoffice-connection'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import { normalizeTaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { AppState } from '@/store/types'

export type BackofficeTodoState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | {
      phase: 'ready'
      items: BackofficeTodoItem[]
      baseUrl: string
      employeeId: string | null
      generatedAt: string | null
    }
  | { phase: 'error'; message: string }

function todoState(load: WorkLoad<TodoFeed> | null): BackofficeTodoState {
  if (!load || load.phase === 'idle' || load.phase === 'not-served') {
    return { phase: 'idle' }
  }
  if (load.phase === 'error') {
    return { phase: 'error', message: load.message }
  }
  // Why: a refresh keeps the previous list on screen instead of flashing "Loading".
  const feed = load.phase === 'ready' ? load.value : load.previous
  if (!feed) {
    return { phase: 'loading' }
  }
  return {
    phase: 'ready',
    items: feed.items,
    baseUrl: feed.baseUrl,
    employeeId: feed.employeeId,
    generatedAt: feed.generatedAt
  }
}

/**
 * Member todo feed for taskSource === 'backoffice'.
 *
 * The list is member-scoped SERVER-side (the BFF derives the employee from
 * the signed-in principal) — no filter UI here, and no client-side employee
 * selection ever. It reads the shared work store, so Tasks, Inbox links and the
 * Attention summary show the same rows from one request.
 */
export function useTaskPageBackofficeFetch(taskSource: string): {
  state: BackofficeTodoState
  refresh: () => void
} {
  const scope = useHandoffScope()
  const todo = useBackofficeWorkStore((state) => (state.scope === scope ? state.todo : null))
  useEffect(() => {
    if (taskSource === 'backoffice') {
      void loadBackofficeWork(scope)
    }
  }, [scope, taskSource])
  const refresh = useCallback(() => void loadBackofficeWork(scope, { force: true }), [scope])
  return { state: todoState(todo), refresh }
}

/**
 * Archive (close) one assigned card.
 *
 * Archive is the backoffice's only closing verb — idempotent and NOT a delete,
 * so the worst a double click does is stamp the same timestamp twice. The list
 * is re-fetched rather than edited in place: the server's answer is what the
 * list shows, here as everywhere else on this page.
 *
 * `pending` names the card currently in flight so the row can disable its own
 * button without freezing the rest of the list.
 */
export function useBackofficeArchive(refresh: () => void): {
  archive: (item: BackofficeTodoItem) => void
  pending: string | null
} {
  const [pending, setPending] = useState<string | null>(null)

  const archive = useCallback(
    (item: BackofficeTodoItem) => {
      if (pending) {
        return
      }
      setPending(item.task_id)
      void window.api.backoffice
        .archiveTask({ taskId: item.task_id })
        .then((result) => {
          if (result.ok) {
            toast.success(
              `${translate('auto.components.TaskPage.backofficeArchived', 'Task archived')} — ${item.title}`
            )
            refresh()
          } else {
            toast.error(result.message)
          }
        })
        .finally(() => setPending(null))
    },
    [pending, refresh]
  )

  return { archive, pending }
}

export function useBackofficeTaskCompletion(refresh: () => void): {
  complete: (item: BackofficeTodoItem, resultRef?: string) => void
  pending: string | null
  /** The card the hub's done-gate is holding until evidence is named. */
  evidenceRequest: BackofficeTodoItem | null
  dismissEvidenceRequest: () => void
} {
  const [pending, setPending] = useState<string | null>(null)
  const [evidenceRequest, setEvidenceRequest] = useState<BackofficeTodoItem | null>(null)
  const dismissEvidenceRequest = useCallback(() => setEvidenceRequest(null), [])

  const complete = useCallback(
    (item: BackofficeTodoItem, resultRef?: string) => {
      if (
        pending ||
        !Number.isSafeInteger(item.state_revision) ||
        (item.state_revision ?? -1) < 0
      ) {
        return
      }
      setPending(item.task_id)
      void window.api.backoffice
        .completeTask({
          taskId: item.task_id,
          expectedRevision: item.state_revision as number,
          ...(resultRef ? { resultRef } : {})
        })
        .then((result) => {
          if (result.ok) {
            setEvidenceRequest(null)
            toast.success(
              `${translate('auto.components.TaskPage.backofficeTaskCompleted', 'Task completed')} — ${item.title}`
            )
            refresh()
          } else if (result.needsEvidence) {
            // Why: the hub refuses "done" on an owned card with acceptance criteria
            // until a result ref is named; ask for it instead of showing the refusal.
            setEvidenceRequest(item)
          } else {
            toast.error(result.message)
            if (result.stale) {
              refresh()
            }
          }
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.TaskPage.backofficeCompleteFailed',
                  'Could not mark the task complete.'
                )
          )
        })
        .finally(() => setPending(null))
    },
    [pending, refresh]
  )

  return { complete, pending, evidenceRequest, dismissEvidenceRequest }
}

export function useBackofficeTaskSourceContext(
  baseUrl: string | null,
  hostId: string
): TaskSourceContext | null {
  return useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'backoffice',
        projectId: 'backoffice',
        hostId,
        providerIdentity: {
          provider: 'backoffice',
          baseUrl
        },
        accountLabel: baseUrl
      }),
    [baseUrl, hostId]
  )
}

export function useTaskPageBackofficeActions({
  baseUrl,
  taskSourceContext,
  openModal
}: {
  baseUrl: string | null
  taskSourceContext: TaskSourceContext | null
  openModal: AppState['openModal']
}) {
  const openComposerForBackofficeItem = useCallback(
    (item: BackofficeTodoItem): boolean => {
      if (!taskSourceContext) {
        toast.error(
          translate(
            'auto.components.TaskPage.backofficeLinkUnavailable',
            'Couldn’t link this task — set the backoffice URL in Settings → Backoffice first.'
          )
        )
        return false
      }
      // WorkspaceLinkedItem requires an absolute, non-empty url; the BFF href
      // is a console SPA path.
      const url =
        item.href && baseUrl
          ? `${baseUrl}${item.href.startsWith('/') ? '' : '/'}${item.href}`
          : (baseUrl ?? 'http://127.0.0.1:4477')
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'backoffice',
        number: 0,
        title: item.title,
        url,
        hubTaskId: item.task_id,
        ...(item.state_revision != null ? { hubStateRevision: item.state_revision } : {}),
        ...(item.next_action ? { hubNextAction: item.next_action } : {})
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: item.title,
        telemetrySource: 'sidebar'
      })
      return true
    },
    [baseUrl, taskSourceContext, openModal]
  )

  const handleUseBackofficeItem = useCallback(
    (item: BackofficeTodoItem): void => {
      openComposerForBackofficeItem(item)
    },
    [openComposerForBackofficeItem]
  )

  return { openComposerForBackofficeItem, handleUseBackofficeItem }
}

/**
 * Open the backoffice's 3D Fleet Office (live agent visualization) in an
 * in-app browser tab of the floating workspace. Uses the CONFIGURED base URL
 * (Settings -> Backoffice), independent of the todo feed's auth state — the
 * page itself handles sign-in in the embedded browser.
 */
export function useOpenBackofficeOffice(): () => void {
  return useCallback(() => {
    void (async () => {
      const store = useAppStore.getState()
      const settings = store.settings
      const resolved = resolveBackofficeBaseUrl(settings ?? {})
      if (!resolved.configured) {
        toast.error(resolved.message)
        return
      }
      try {
        // The tab lands in the FLOATING workspace, which only mounts while the
        // feature is enabled — so creating the tab alone put the office somewhere
        // the user could not see, and the button looked dead. Turn the workspace
        // on first (the keybindings editor opens the same way), then ask it to be
        // visible once the tab exists.
        if (settings?.floatingTerminalEnabled !== true) {
          await store.updateSettings({ floatingTerminalEnabled: true })
        }
        useAppStore
          .getState()
          .createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, `${resolved.baseUrl}/fleet/office`, {
            title: translate('auto.components.TaskPage.backofficeOfficeTab', '3D Office'),
            activate: true
          })
        requestFloatingTerminalOpen()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [])
}
