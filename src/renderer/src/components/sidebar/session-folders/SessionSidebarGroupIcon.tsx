import {
  Activity,
  Archive,
  Bot,
  Building2,
  CircleCheck,
  FolderKanban,
  Hourglass,
  Monitor,
  ScrollText,
  CircleStop,
  EyeOff,
  Folder,
  FolderOpen,
  ListChecks,
  MessageSquare,
  PencilLine,
  Search
} from 'lucide-react'
import { SnoozeIcon } from '@/components/next-step/SnoozeIcon'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import type { SessionSidebarGroup as SessionSidebarGroupModel } from '@/lib/session-sidebar-tree'
import { cn } from '@/lib/utils'
import { sessionFolderColorVar, type SessionFolderColor } from '@/lib/session-folder-colors'

const groupIcons: Record<
  SessionSidebarGroupModel['kind'],
  React.ComponentType<{ className?: string }>
> = {
  attention: AgentQuestionIcon,
  drafts: PencilLine,
  waiting: SnoozeIcon,
  stopped: CircleStop,
  completed: CircleCheck,
  saved: Folder,
  archived: Archive,
  hidden: EyeOff,
  workers: Bot,
  folder: Folder,
  workspace: MessageSquare,
  task: ListChecks,
  search: Search,
  state: Activity,
  request: ScrollText,
  project: FolderKanban,
  company: Building2,
  computer: Monitor,
  blocking: Hourglass
}

/** One glyph per group kind: the sidebar reads what a group holds before its label. */
export function SessionSidebarGroupIcon({
  kind,
  color = null,
  open = false
}: {
  kind: SessionSidebarGroupModel['kind']
  /** A folder's chosen color fills its glyph. */
  color?: SessionFolderColor | null
  /** An unfolded folder shows an open folder, so what is inside it reads as inside. */
  open?: boolean
}): React.JSX.Element {
  const Icon = open && (kind === 'folder' || kind === 'saved') ? FolderOpen : groupIcons[kind]
  if (color) {
    return (
      <span className="inline-flex shrink-0" style={{ color: sessionFolderColorVar(color) }}>
        <Icon className="size-3.5 shrink-0 fill-[color-mix(in_srgb,currentColor_30%,transparent)]" />
      </span>
    )
  }
  const muted = kind !== 'attention' && 'text-muted-foreground'
  return <Icon className={cn('size-3.5 shrink-0', muted)} />
}
