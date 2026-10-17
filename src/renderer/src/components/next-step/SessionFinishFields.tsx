import { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SessionFolderNamePopover } from '@/components/sidebar/session-folders/SessionFolderNamePopover'
import { useSessionFolders } from '@/store/session-folders'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFinishAction } from '@/lib/session-folders'
import { sessionFolderPath, sessionFolderTree } from '@/lib/session-folder-tree'
import { createFolderByPerson } from '@/lib/session-organization-person-changes'
import { cn } from '@/lib/utils'

const ACTIONS = ['me', 'end', 'save'] as const

/** The visible name of each finish choice; shared by Next actions, ✓ Done and the bulk flows. */
export function sessionFinishActionLabel(action: SessionFinishAction['action']): string {
  switch (action) {
    case 'save':
      return translate('nextStep.saveSessionLabel', 'Save session')
    case 'end':
      return translate('nextStep.endSessionLabel', 'End session')
    case 'me':
      return translate('chatActions.complete', 'Complete')
  }
}

function sessionFinishActionHint(action: SessionFinishAction['action']): string {
  switch (action) {
    case 'save':
      return translate(
        'nextStep.saveSessionLabelHint',
        'Save session — kept under Saved Sessions to reopen later.'
      )
    case 'end':
      return translate(
        'nextStep.endSessionLabelHint',
        'End session — the tab closes; its history stays in Recently closed.'
      )
    case 'me':
      return translate(
        'nextStep.completeHint',
        'Complete — this session moves to Done and stays available.'
      )
  }
}

/**
 * Reads the folders on mount so the one consumer that renders it alone — the Done block's
 * When finished — needs no copy of this list; the guard makes the second call a no-op.
 */
export function useLoadedSessionFolders() {
  const folders = useSessionFolders()
  const { loaded, load } = folders
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [loaded, load])
  return folders
}

/** The saved-session folder select and New folder; shared with the Done block's When finished. */
export function SavedFolderChooser({
  value,
  onChange
}: {
  value: SessionFinishAction
  onChange: (value: SessionFinishAction) => void
}): React.JSX.Element {
  const folders = useLoadedSessionFolders()
  const savedFolders = folders.metadata.folders.filter((folder) => folder.section === 'saved')
  return (
    <div className="flex items-center gap-1">
      <Select
        value={
          savedFolders.some((folder) => folder.id === value.folderId)
            ? value.folderId!
            : SAVED_SESSIONS_FOLDER_ID
        }
        onValueChange={(folderId) => onChange({ ...value, folderId })}
      >
        <SelectTrigger
          className="h-8 min-w-0 flex-1"
          aria-label={translate('nextStep.savedSessionFolder', 'Saved session folder')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SAVED_SESSIONS_FOLDER_ID}>
            {translate('conversations.savedSessions', 'Saved Sessions')}
          </SelectItem>
          {sessionFolderTree(savedFolders).map(({ folder }) => (
            <SelectItem key={folder.id} value={folder.id}>
              {sessionFolderPath(savedFolders, folder)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SessionFolderNamePopover
        folders={folders.metadata.folders}
        onSave={(name) => {
          const folderId = createFolderByPerson(name, 'saved', undefined, { via: 'work' })
          if (!folderId) {
            return false
          }
          onChange({ ...value, folderId })
          return true
        }}
      >
        <Button type="button" variant="ghost" size="xs">
          {translate('auto.components.SessionSidebar.newFolder', 'New folder')}
        </Button>
      </SessionFolderNamePopover>
    </div>
  )
}

/**
 * What happens to this session once the work is through. `stack` is the form ✓ Done and the
 * bulk flows show; `row` is the Next actions line — "When done · Complete" with the three
 * choices as one quiet segmented control and the hint only while hovered or focused.
 */
export function SessionFinishFields({
  value,
  onChange,
  layout = 'stack'
}: {
  value: SessionFinishAction
  onChange: (value: SessionFinishAction) => void
  layout?: 'stack' | 'row'
}): React.JSX.Element {
  const folders = useLoadedSessionFolders()
  const row = layout === 'row'
  const choices = (
    <div
      className={cn(
        'flex flex-wrap gap-1',
        row && 'shrink-0 rounded-md border border-border p-0.5'
      )}
      role="group"
      aria-label={translate('nextStep.sessionFinish', 'Session finish')}
    >
      {ACTIONS.map((action) => (
        <Button
          key={action}
          type="button"
          size="xs"
          variant={value.action === action ? 'secondary' : 'ghost'}
          aria-pressed={value.action === action}
          className={cn(row && 'h-6 px-2 text-[11px]')}
          onClick={() => onChange({ ...value, action })}
        >
          {sessionFinishActionLabel(action)}
        </Button>
      ))}
    </div>
  )
  return (
    <div
      className={cn(row ? 'group/row space-y-1.5' : 'space-y-2 border-t border-border/60 pt-3')}
      data-session-finish-fields
      data-next-step-section="once-done"
    >
      {row ? (
        <div className="flex min-h-7 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs">
            <span className="font-medium">{translate('nextStep.whenDone', 'When done')}</span>
            <span className="text-muted-foreground">
              {' · '}
              <span data-next-step-summary="once-done">
                {sessionFinishActionLabel(value.action)}
              </span>
            </span>
          </p>
          {choices}
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold">{translate('nextStep.whenDone', 'When done')}</p>
          {choices}
        </>
      )}
      {value.action === 'save' ? <SavedFolderChooser value={value} onChange={onChange} /> : null}
      <p
        className={cn(
          'text-xs text-muted-foreground',
          row &&
            'h-4 truncate text-[11px] leading-4 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none'
        )}
        data-next-step-hint="once-done"
      >
        {sessionFinishActionHint(value.action)}
      </p>
      {folders.error ? (
        <p className="text-xs text-destructive" role="alert">
          {folders.error}
        </p>
      ) : null}
    </div>
  )
}
