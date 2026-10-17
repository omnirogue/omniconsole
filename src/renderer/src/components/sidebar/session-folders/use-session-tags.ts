import { conversationFleetSource } from '@/lib/conversation-fleet-sidebar'
import { isRoutineBackedSession } from '@/lib/routine-backed-session'
import { matchesSessionTagFilter, sessionTagIds } from '@/lib/session-tags'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useSessionTags } from '@/store/session-tags'
import { conversationViewKey } from '@/lib/conversation-view'
import { automaticSessionTag } from '@/lib/session-automatic-tag'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { filterSessionsByAgent } from '@/lib/session-agent-filter'
import { useSessionAgentFilter } from '@/store/session-agent-filter'
export function useSessionTagIds(sessions: readonly SidebarSession[]) {
  const tags = useSessionTags()
  const { loaded, error, load, migrateSessionKey } = tags
  const context = useAppStore(
    useShallow((state) => ({
      worktrees: state.worktreesByRepo,
      folders: state.folderWorkspaces,
      workRoot: state.settings?.companyWorkRoot,
      overrides: state.settings?.companyFolders,
      getKnown: state.getKnownWorktreeById
    }))
  )
  const [home, setHome] = useState('')
  useEffect(() => {
    let live = true
    void getCompanyFolderHome().then((value) => {
      if (live) {
        setHome(value)
      }
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!loaded && !error) {
      load()
    }
  }, [loaded, error, load])
  useEffect(() => {
    if (!loaded) {
      return
    }
    for (const session of sessions) {
      if (session.folderKeyMigration) {
        migrateSessionKey(session.folderKeyMigration.from, session.folderKeyMigration.to)
      }
    }
  }, [sessions, loaded, migrateSessionKey])
  return useMemo(
    () =>
      new Map(
        sessions.map((session) => {
          const automatic = automaticSessionTag(session, {
            home,
            workRoot: context.workRoot,
            overrides: context.overrides,
            getKnown: context.getKnown
          })
          return [
            conversationViewKey(session),
            sessionTagIds(tags.data, conversationViewKey(session), automatic)
          ]
        })
      ),
    [sessions, context, tags.data, home]
  )
}

export function useSessionTagSearchText(
  ids: ReadonlyMap<string, string[]>,
  taskFor?: (session: SidebarSession) => { title?: string | null } | null | undefined
) {
  const tags = useSessionTags((state) => state.data.tags)
  return useMemo(
    () => (session: SidebarSession) =>
      [
        taskFor?.(session)?.title ?? '',
        ...tags
          .filter((tag) => ids.get(conversationViewKey(session))?.includes(tag.id))
          .map((tag) => tag.name)
      ].join(' '),
    [ids, tags, taskFor]
  )
}

export function useTaggedSidebarSessions(
  sessions: readonly SidebarSession[],
  routineOwners: Parameters<typeof isRoutineBackedSession>[1]
) {
  const filter = useSessionTags((state) => state.data.filter)
  const tagIds = useSessionTagIds(sessions)
  const allSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !isRoutineBackedSession(session, routineOwners) &&
          matchesSessionTagFilter(tagIds.get(conversationViewKey(session)) ?? [], filter)
      ),
    [sessions, routineOwners, tagIds, filter]
  )
  return { allSessions, tagIds }
}

export function useTagFilteredFleetRuns<T extends Parameters<typeof conversationFleetSource>[0]>(
  runs: readonly T[],
  sessions: readonly SidebarSession[],
  ids: ReadonlyMap<string, string[]>
): readonly T[] {
  const filter = useSessionTags((state) => state.data.filter)
  return useMemo(
    () =>
      filter.length
        ? runs.filter((run) => {
            const source = conversationFleetSource(run, sessions)
            return source
              ? matchesSessionTagFilter(ids.get(conversationViewKey(source)) ?? [], filter)
              : false
          })
        : runs,
    [runs, sessions, ids, filter]
  )
}

/** A pressed agent logo lists that agent's unarchived conversations only, on top of tags and text. */
export function useAgentFilteredSidebarSessions(
  sessions: readonly SidebarSession[],
  archivedKeys: ReadonlySet<string>
): readonly SidebarSession[] {
  const filter = useSessionAgentFilter((state) => state.filter)
  return useMemo(
    () => filterSessionsByAgent(sessions, filter, archivedKeys),
    [sessions, filter, archivedKeys]
  )
}
