import { Folder } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'

/** How many folders sit directly inside a folder heading (or at the top of Saved Sessions). */
export function sessionSubfolderCount(
  group: { kind: string; folder?: SessionFolder | null },
  folders: readonly SessionFolder[]
): number {
  if (group.folder) {
    return folders.filter((folder) => folder.parentId === group.folder!.id).length
  }
  if (group.kind === 'saved') {
    return folders.filter((folder) => folder.section === 'saved' && !folder.parentId).length
  }
  return 0
}

/**
 * A small folder glyph and count beside a heading's session count, so a folder that holds only
 * folders reads as full rather than empty before it is opened.
 */
export function SessionSubfolderMark({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) {
    return null
  }
  const label = translate('conversations.subfolderCount', 'Folders inside: {{count}}', { count })
  return (
    <span
      data-session-group-subfolders={count}
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground"
    >
      <Folder className="size-3" aria-hidden strokeWidth={1.75} />
      {count}
    </span>
  )
}
