import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { BackofficeWorkList } from './backoffice-work-list'
import { invalidateBackofficeWork } from './backoffice-work-store'
import {
  canSelectWorkRow,
  runBulkWorkAction,
  type BulkWorkAction,
  type BulkWorkResult
} from './backoffice-bulk-actions'

type ActionListProps = ComponentProps<typeof BackofficeWorkList> & {
  scope: string
  viewer: string | null
  archived?: boolean
  removalLabel?: 'archive' | 'delete'
  toolbar?: ReactNode
  onChanged?: () => void
  selectionRequest?: string[]
  onActionResults?: (results: BulkWorkResult[]) => void
  selectionPending?: boolean
}

/** Account changes discard selection and stop the old batch before its next operation. */
export function BackofficeActionList(props: ActionListProps) {
  return <ScopedWorkActionList key={`${props.scope}:${props.viewer ?? ''}`} {...props} />
}

function ScopedWorkActionList({
  scope,
  viewer,
  archived = false,
  removalLabel = 'archive',
  toolbar,
  onChanged,
  selectionRequest,
  onActionResults,
  selectionPending = false,
  ...props
}: ActionListProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [results, setResults] = useState<BulkWorkResult[]>([])
  const alive = useRef(true)
  const busy = useRef(false)
  const actionsPending = pending || selectionPending
  useEffect(() => {
    if (selectionRequest) {
      setSelected(selectionRequest)
    }
  }, [selectionRequest])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const selectable = props.rows.filter((row) => canSelectWorkRow(row, viewer))
  const chosen = selectable.filter((row) => selected.includes(row.key))
  const isCurrent = () =>
    alive.current && selectConsoleAccountScope(useAppStore.getState()) === scope
  const run = async (action: BulkWorkAction, keys: string[]) => {
    if (busy.current || selectionPending || !isCurrent()) {
      return
    }
    busy.current = true
    setPending(true)
    setResults([])
    setSelected((current) => [...new Set([...current, ...keys])])
    try {
      const outcome = await runBulkWorkAction(
        selectable.filter((row) => keys.includes(row.key)),
        action,
        isCurrent,
        { scope, viewer }
      )
      if (!isCurrent()) {
        return
      }
      setResults(outcome)
      onActionResults?.(outcome)
      const done = new Set(outcome.filter((row) => row.ok).map((row) => row.key))
      setSelected((current) => current.filter((key) => !done.has(key)))
      invalidateBackofficeWork()
      onChanged?.()
    } finally {
      busy.current = false
      if (isCurrent()) {
        setPending(false)
      }
    }
  }
  return (
    <>
      {selectable.length > 0 || toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          {toolbar}
          {selectable.length > 0 ? (
            <>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  disabled={actionsPending}
                  checked={
                    chosen.length === selectable.length
                      ? true
                      : chosen.length > 0
                        ? 'indeterminate'
                        : false
                  }
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked === true
                        ? [...new Set([...current, ...selectable.map((row) => row.key)])]
                        : current.filter((key) => !selectable.some((row) => row.key === key))
                    )
                  }
                />
                {translate('workActions.selectVisibleItems', 'Select all visible items')}
              </label>
              <span className="text-xs text-muted-foreground">
                {translate('workActions.selectedCount', '{{count}} selected', {
                  count: chosen.length
                })}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={actionsPending || chosen.length === 0}
                onClick={() =>
                  void run(
                    archived ? 'restore' : 'archive',
                    chosen.map((row) => row.key)
                  )
                }
              >
                {archived
                  ? translate('workActions.restoreSelected', 'Restore selected')
                  : removalLabel === 'delete'
                    ? translate('inbox.deleteSelected', 'Delete selected')
                    : translate('workActions.archiveSelected', 'Archive selected')}
              </Button>
              {!archived && selectable.some((row) => !row.message) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    actionsPending || chosen.length === 0 || chosen.some((row) => !!row.message)
                  }
                  onClick={() =>
                    void run(
                      'complete',
                      chosen.map((row) => row.key)
                    )
                  }
                >
                  {translate('workActions.completeSelected', 'Mark selected complete')}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="p-2 text-xs">
          {translate('workActions.updatingItems', 'Updating selected items…')}
        </p>
      ) : null}
      {results.length > 0 ? (
        <div role="status" className="p-2 text-xs">
          <p>
            {translate('workActions.itemsUpdated', 'Items updated: {{count}}', {
              count: results.filter((row) => row.ok).length
            })}
          </p>
          {results
            .filter((row) => !row.ok)
            .map((row) => (
              <p key={row.key} role="alert">
                {row.title}: {row.message}
              </p>
            ))}
        </div>
      ) : null}
      <BackofficeWorkList
        {...props}
        actions={{
          selected: chosen.map((row) => row.key),
          selectable: selectable.map((row) => row.key),
          pending: actionsPending,
          archived,
          removalLabel,
          onToggle: (key) =>
            setSelected((current) =>
              current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
            ),
          onArchive: (key) => void run(archived ? 'restore' : 'archive', [key])
        }}
      />
    </>
  )
}
