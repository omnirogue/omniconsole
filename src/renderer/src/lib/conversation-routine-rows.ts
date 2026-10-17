import type { Automation } from '../../../shared/automations-types'
import type { AutomationHostTarget } from '@/components/automations/automation-host-client'
import { routineMatchesQuery } from '@/components/sidebar/routines/routine-list-filter'
import { routineHiddenKey, routineViewKey } from '@/components/sidebar/routines/routine-view-key'
import { conversationGroupLabel } from './conversation-state'
import {
  conversationGroupInsertIndex,
  conversationSidebarGroupLabel,
  type ConversationFleetSidebarGroup
} from './conversation-fleet-sidebar'
import {
  getSessionFolderId,
  isSavedSessionFolder,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolderMetadata
} from './session-folders'
import {
  isSessionGroupCollapsed,
  sessionFolderGroupKey,
  SESSION_ARCHIVED_GROUP_KEY,
  SESSION_HIDDEN_GROUP_KEY,
  type SessionSidebarView
} from './session-sidebar-view'
import { SESSION_OTHER_GROUP_KEY, type SessionSidebarGroup } from './session-sidebar-tree'

/** One routine listed among the conversations. */
export type ConversationRoutineRow = {
  automation: Automation
  /** `routine:<authority>:<id>` — the key it is filed, hidden and archived by. */
  key: string
  folderId: string | null
  hidden: boolean
  archived: boolean
}

export type ConversationRoutineGroup = ConversationFleetSidebarGroup & {
  routineRows: ConversationRoutineRow[]
}

const COUNTED_KINDS = new Set(['drafts', 'waiting', 'completed', 'archived', 'hidden', 'stopped'])

function relabel(group: ConversationRoutineGroup): void {
  if (!COUNTED_KINDS.has(group.kind)) {
    return
  }
  const count = group.rows.length + group.fleetRows.length + group.routineRows.length
  group.label = conversationGroupLabel(
    group.kind as Parameters<typeof conversationGroupLabel>[0],
    count
  )
}

/**
 * Routines join the conversation groups as rows of their own: a routine filed in a folder sits in
 * that folder, a running one with Active and a paused one with Stopped; hidden and archived ones
 * come back only where their conversations do. The runs a routine launches stay out of the list —
 * the routine's row opens its conversation.
 */
export function addConversationRoutineRows(args: {
  groups: readonly ConversationFleetSidebarGroup[]
  automations: readonly Automation[]
  target: AutomationHostTarget
  metadata: SessionFolderMetadata
  view: SessionSidebarView
  /** Routine keys archived by hand on this device. */
  archivedKeys: ReadonlySet<string>
  query: string
  showHidden: boolean
  showArchived: boolean
  /** The caption a person reads under the name, so search finds "weekdays" too. */
  scheduleLabel?: (automation: Automation) => string
}): {
  groups: ConversationRoutineGroup[]
  hiddenCount: number
  archivedCount: number
} {
  const groups: ConversationRoutineGroup[] = args.groups.map((group) => ({
    ...group,
    routineRows: []
  }))
  const query = args.query.trim().toLowerCase()
  const hiddenGroupKeys = new Set(args.view.hidden)
  const rowOrder = new Map((args.view.rowOrder ?? []).map((key, index) => [key, index]))
  const rows = args.automations
    .map((automation): ConversationRoutineRow => {
      const key = routineViewKey(args.target, automation)
      return {
        automation,
        key,
        folderId: getSessionFolderId(args.metadata, key),
        hidden: hiddenGroupKeys.has(routineHiddenKey(key)),
        archived: args.archivedKeys.has(key) || (args.view.archived?.includes(key) ?? false)
      }
    })
    .sort(
      (a, b) =>
        (rowOrder.get(a.key) ?? Infinity) - (rowOrder.get(b.key) ?? Infinity) ||
        a.automation.name.localeCompare(b.automation.name)
    )
  let hiddenCount = 0
  let archivedCount = 0

  const findOrCreate = (
    kind: SessionSidebarGroup['kind'],
    key: string,
    shell?: Partial<SessionSidebarGroup>
  ): ConversationRoutineGroup | null => {
    const existing = groups.find((group) => group.key === key)
    if (existing) {
      return existing
    }
    // Why: a group the person hid takes its routines with it, as it does its conversations.
    if (hiddenGroupKeys.has(key) && !args.showHidden) {
      return null
    }
    const group: ConversationRoutineGroup = {
      key,
      kind,
      label: conversationSidebarGroupLabel(kind),
      rows: [],
      fleetRows: [],
      routineRows: [],
      collapsed: !query && isSessionGroupCollapsed(args.view, key),
      hidden: hiddenGroupKeys.has(key),
      attentionCount: 0,
      canHide: false,
      canReorder: false,
      ...shell
    }
    // Why: a folder a search emptied comes back ahead of the automatic groups, where it was.
    const firstAfterAttention = groups.findIndex((candidate) => candidate.kind !== 'attention')
    const index =
      kind !== 'folder'
        ? conversationGroupInsertIndex(groups, kind)
        : firstAfterAttention === -1
          ? groups.length
          : firstAfterAttention
    groups.splice(index, 0, group)
    return group
  }

  for (const row of rows) {
    if (args.view.deleted?.includes(row.key)) {
      continue
    }
    if (
      query &&
      !routineMatchesQuery(row.automation, query) &&
      !(args.scheduleLabel?.(row.automation).toLowerCase().includes(query) ?? false)
    ) {
      continue
    }
    let group: ConversationRoutineGroup | null = null
    if (row.hidden) {
      hiddenCount += 1
      if (!args.showHidden) {
        continue
      }
      group = findOrCreate('hidden', SESSION_HIDDEN_GROUP_KEY)
    } else if (row.archived) {
      archivedCount += 1
      if (!args.showArchived && !query) {
        continue
      }
      group = findOrCreate('archived', SESSION_ARCHIVED_GROUP_KEY)
    } else if (row.folderId && isSavedSessionFolder(args.metadata, row.folderId)) {
      // Why: a routine saved into a (nested) saved folder sits there with the saved sessions;
      // when that folder is folded away, so is the routine.
      const key =
        row.folderId === SAVED_SESSIONS_FOLDER_ID
          ? SAVED_SESSIONS_FOLDER_ID
          : sessionFolderGroupKey(row.folderId)
      group = groups.find((candidate) => candidate.key === key) ?? null
      if (!group) {
        continue
      }
    } else {
      const folder = row.folderId
        ? args.metadata.folders.find(
            (entry) => entry.id === row.folderId && entry.section !== 'saved'
          )
        : undefined
      if (folder) {
        const key = sessionFolderGroupKey(folder.id)
        if (hiddenGroupKeys.has(key) && !args.showHidden) {
          continue
        }
        group = findOrCreate('folder', key, {
          label: folder.name,
          folder,
          collapsed: !query && isSessionGroupCollapsed(args.view, key),
          canReorder: true,
          canHide: true
        })
      } else if (row.automation.enabled) {
        group = findOrCreate('workspace', SESSION_OTHER_GROUP_KEY, {
          canReorder: true,
          canHide: true
        })
      } else {
        group = findOrCreate('stopped', 'stopped')
      }
    }
    if (group) {
      group.routineRows.push(row)
      relabel(group)
    }
  }
  return { groups, hiddenCount, archivedCount }
}
