import { cn } from '@/lib/utils'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'

/** The rail sits where FolderNestingGuides draws a subfolder's line (6px in), elbows reach each row. */
const SESSION_FOLDER_BODY_CLASS = cn(
  'ml-1.5 rounded-r-md border-l border-muted-foreground/45 bg-worktree-sidebar-accent/35 pl-[17px]',
  "[&>*]:relative [&>*]:before:pointer-events-none [&>*]:before:absolute [&>*]:before:top-[13px] [&>*]:before:-left-[17px] [&>*]:before:h-px [&>*]:before:w-3 [&>*]:before:bg-muted-foreground/45 [&>*]:before:content-['']"
)

/**
 * A folder heading's +, new-folder and ⋯: at rest they take no width and draw nothing, so the
 * name keeps the row; on hover, focus or an open popover they overlay the heading's right end.
 * Touch keeps them in the row.
 */
const FOLDER_HEADER_HOVER_ACTIONS = cn(
  'flex shrink-0 items-center',
  'can-hover:pointer-events-none can-hover:absolute can-hover:inset-y-0 can-hover:right-0 can-hover:rounded-r-md can-hover:bg-worktree-sidebar-accent can-hover:pr-1 can-hover:pl-1 can-hover:opacity-0 can-hover:transition-opacity',
  'group-hover/session-header:pointer-events-auto group-hover/session-header:opacity-100',
  'focus-within:pointer-events-auto focus-within:opacity-100',
  'has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100',
  'has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100'
)

/**
 * A group's body. A folder's sessions hang off the same tree line as its subfolders, one full step
 * in (level with a subfolder's checkbox), each on an elbow, on a faint band that marks them as the
 * folder's own — so a session never reads as a sibling of its folder.
 */
export function sessionGroupBodyClass(kind: SessionSidebarGroup['kind']): string {
  return kind === 'folder' || kind === 'saved'
    ? SESSION_FOLDER_BODY_CLASS
    : 'ml-2 border-l border-worktree-sidebar-border/60 pl-1'
}

/**
 * A heading's trailing controls: overlaid on a folder heading; in the row on any other heading,
 * whose own in-row controls (Saved Sessions' eye and New folder) the overlay would cover.
 */
export function groupHeaderActionsClass(group: Pick<SessionSidebarGroup, 'folder'>): string {
  return group.folder ? FOLDER_HEADER_HOVER_ACTIONS : 'contents'
}
