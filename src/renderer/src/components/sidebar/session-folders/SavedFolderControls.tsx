import { FolderInput, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import { cn } from '@/lib/utils'
import {
  sessionFolderPath,
  sessionFolderSubtreeIds,
  sessionFolderTree
} from '@/lib/session-folder-tree'
import { SessionFolderNamePopover } from './SessionFolderNamePopover'
import { moveSavedFolder } from './use-selected-sidebar-rows'

/** The + on a saved folder's heading: a new folder inside this one. */
export function SavedSubfolderButton({
  folder,
  folders,
  onCreate,
  onCreated
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
  onCreate: (name: string, parentId: string) => boolean
  /** Runs after a subfolder is made, e.g. to unfold this folder so the new one shows. */
  onCreated?: () => void
}): React.JSX.Element {
  return (
    <SessionFolderNamePopover
      folders={folders}
      parentId={folder.id}
      onSave={(name) => {
        const created = onCreate(name, folder.id)
        if (created) {
          onCreated?.()
        }
        return created
      }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label={translate('conversations.newSubfolderIn', 'New folder inside {{folder}}', {
          folder: folder.name
        })}
      >
        <FolderPlus className="size-3.5" />
      </Button>
    </SessionFolderNamePopover>
  )
}

/** How far each nesting level steps in, in px. */
export const FOLDER_INDENT = 12

/** How many levels a folder sits in: under Saved Sessions counts as one. */
export function folderNestingLevels(folder: SessionFolder | undefined, depth = 0): number {
  if (!folder) {
    return 0
  }
  return folder.section === 'saved' ? depth + 1 : depth
}

/**
 * Each nesting level steps in under its parent, starting one step inside Saved Sessions; a
 * Conversations folder steps in only when it sits inside another folder.
 */
export function savedFolderIndentStyle(
  folder: SessionFolder | undefined,
  depth = 0
): React.CSSProperties | undefined {
  const levels = folderNestingLevels(folder, depth)
  return levels > 0 ? { marginLeft: FOLDER_INDENT * levels } : undefined
}

/**
 * The tree lines to the left of a nested folder: one vertical guide per level it sits in,
 * lined up under each ancestor's chevron, and an elbow into this folder's own heading, so
 * "this folder is inside that one" reads at a glance, as in a file browser.
 */
export function FolderNestingGuides({ levels }: { levels: number }): React.JSX.Element | null {
  if (levels === 0) {
    return null
  }
  const inset = FOLDER_INDENT / 2
  return (
    <>
      {Array.from({ length: levels }, (_, index) => {
        const level = levels - index
        return (
          <span
            key={level}
            aria-hidden
            data-folder-guide={level}
            className={cn(
              'pointer-events-none absolute top-0 -bottom-1 w-px',
              level === 1 ? 'bg-muted-foreground/45' : 'bg-worktree-sidebar-border'
            )}
            style={{ left: -FOLDER_INDENT * level + inset }}
          />
        )
      })}
      <span
        aria-hidden
        data-folder-guide-elbow=""
        className="pointer-events-none absolute top-[13px] h-px bg-muted-foreground/45"
        style={{ left: -FOLDER_INDENT + inset, width: FOLDER_INDENT - inset }}
      />
    </>
  )
}

/**
 * "Move folder into…" for a saved folder: the top of Saved Sessions or any other saved folder,
 * except itself and its own subfolders. Its sessions and subfolders go with it.
 */
export function SavedFolderMoveMenu({
  folder,
  folders
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
}): React.JSX.Element {
  const onMove = (parentId: string | null): void => {
    moveSavedFolder(folder.id, parentId)
  }
  const saved = folders.filter((entry) => entry.section === 'saved')
  const own = sessionFolderSubtreeIds(saved, folder.id)
  const targets = sessionFolderTree(saved).filter(({ folder: entry }) => !own.has(entry.id))
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput className="size-3.5" />
        {translate('conversations.moveFolderInto', 'Move folder into…')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="scrollbar-sleek max-h-80 w-56 overflow-y-auto">
        <DropdownMenuItem disabled={!folder.parentId} onSelect={() => onMove(null)}>
          {translate('conversations.savedSessionsTop', 'Saved Sessions (top level)')}
        </DropdownMenuItem>
        {targets.length > 0 ? <DropdownMenuSeparator /> : null}
        {targets.map(({ folder: target, depth }) => (
          <DropdownMenuItem
            key={target.id}
            disabled={target.id === folder.parentId}
            title={sessionFolderPath(saved, target)}
            onSelect={() => onMove(target.id)}
          >
            <span className="truncate" style={{ paddingLeft: depth * 12 }}>
              {target.name}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
