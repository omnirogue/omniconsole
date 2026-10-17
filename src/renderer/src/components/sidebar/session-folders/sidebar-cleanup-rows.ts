import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  conversationFleetRowKey,
  conversationFleetSource,
  type ConversationFleetSidebarRow
} from '@/lib/conversation-fleet-sidebar'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'
import { archiveSessionsByPerson } from '@/lib/session-organization-person-changes'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import type { RoutineCommands } from '../routines/routine-row-commands'

export type SidebarCleanupGroup = SessionSidebarGroup & {
  fleetRows?: readonly ConversationFleetSidebarRow[]
  routineRows?: readonly ConversationRoutineRow[]
}

export function fleetCleanupRows(rows: readonly ConversationFleetSidebarRow[]) {
  return rows.map(({ run, source }) => ({
    key: conversationFleetRowKey(run, source),
    label: run.title
  }))
}

/** Pause before putting a routine away; a refused pause must remain visible. */
export async function pauseCleanupRoutines(
  rows: readonly ConversationRoutineRow[],
  commands?: Pick<RoutineCommands, 'setEnabled'>
): Promise<ConversationRoutineRow[]> {
  const paused: ConversationRoutineRow[] = []
  for (const row of rows) {
    if (!row.automation.enabled || (await commands?.setEnabled(row.automation, false))) {
      paused.push(row)
    }
  }
  return paused
}

export async function archiveCleanupRows(
  keys: readonly string[],
  routines: readonly ConversationRoutineRow[],
  commands?: Pick<RoutineCommands, 'setEnabled'>
): Promise<string[]> {
  const paused = await pauseCleanupRoutines(routines, commands)
  const eligible = [...new Set([...keys, ...paused.map((row) => row.key)])]
  return (await archiveSessionsByPerson(eligible, true)) ? eligible : []
}

export function archivedFleetCount(
  runs: readonly ConversationFleetView[],
  sessions: readonly SidebarSession[],
  archived: ReadonlySet<string>,
  deleted: readonly string[] = []
): number {
  return runs.filter((run) => {
    const source = conversationFleetSource(run, sessions)
    const key = conversationFleetRowKey(run, source)
    return archived.has(key) && (source?.tabId || !deleted.includes(key))
  }).length
}
