import { useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import {
  SESSION_FOLDER_NAME_LIMIT,
  sessionFolderNameError,
  type SessionFolder
} from '@/lib/session-folders'

type Props = {
  folder?: SessionFolder
  folders: readonly SessionFolder[]
  /** A new folder goes inside this one; its name need only differ from its siblings'. */
  parentId?: string | null
  children: ReactNode
  onSave: (name: string) => boolean
  /** Controlled open state, for callers that open the editor from a menu rather than the trigger. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SessionFolderNamePopover({
  folder,
  folders,
  parentId,
  children,
  onSave,
  open: controlledOpen,
  onOpenChange
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean): void => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [name, setName] = useState(folder?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setName(folder?.name ?? '')
          setError(null)
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const validation = sessionFolderNameError(folders, name, folder?.id, parentId)
            setError(validation)
            if (!validation && onSave(name)) {
              setOpen(false)
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={inputId}>
              {folder
                ? translate('auto.components.SessionSidebar.renameFolder', 'Rename folder')
                : parentId
                  ? translate('conversations.newSubfolderLabel', 'New subfolder')
                  : translate('conversations.newFolderLabel', 'New folder')}
            </Label>
            <Input
              id={inputId}
              autoFocus
              value={name}
              maxLength={SESSION_FOLDER_NAME_LIMIT}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${inputId}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
            {error ? (
              <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
              {translate('auto.components.SessionSidebar.cancel', 'Cancel')}
            </Button>
            <Button size="sm" type="submit">
              {folder
                ? translate('auto.components.SessionSidebar.save', 'Save')
                : translate('auto.components.SessionSidebar.create', 'Create')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
