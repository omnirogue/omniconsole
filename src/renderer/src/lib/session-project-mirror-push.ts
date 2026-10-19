import { listSessionFolderEntries } from '@/lib/session-folder-cli-list'
import { ensureBuiltinUniversalProjects } from '@/lib/session-organization-person-changes'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

const PUSH_DELAY_MS = 500

/** Keeps main's copy of the folders and project settings current (session-project-mirror.ts). */
export function registerSessionProjectMirrorPush(unsubs: (() => void)[]): void {
  // Why optional: partial preload doubles in tests and older preloads have no mirror channel.
  if (typeof window.api.ui.mirrorSessionProjects !== 'function') {
    return
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let pushed: unknown = null
  const push = (): void => {
    timer = null
    if (!useSessionFolders.getState().loaded) {
      useSessionFolders.getState().load()
    }
    if (useSessionFolders.getState().loaded) {
      ensureBuiltinUniversalProjects()
    }
    const { loaded, metadata } = useSessionFolders.getState()
    // Why the identity check: the store changes for many reasons; only folders and projects matter.
    if (!loaded || pushed === metadata) {
      return
    }
    pushed = metadata
    const entries = listSessionFolderEntries(metadata, useSessionSidebarView.getState().view)
    window.api.ui.mirrorSessionProjects({
      folders: entries.map(({ id, name, path, section, parentId }) => ({
        id,
        name,
        path,
        section,
        parentId
      })),
      projects: metadata.projects ?? {},
      savedAt: Date.now()
    })
  }
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(push, PUSH_DELAY_MS)
  }
  schedule()
  let lastRepoCount = useAppStore.getState()?.repos?.length ?? 0
  let lastWorktreeTabCount = Object.keys(useAppStore.getState()?.tabsByWorktree ?? {}).length
  unsubs.push(
    useSessionFolders.subscribe(schedule),
    useAppStore.subscribe((state) => {
      const repoCount = state.repos?.length ?? 0
      const worktreeTabCount = Object.keys(state.tabsByWorktree ?? {}).length
      if (repoCount !== lastRepoCount || worktreeTabCount !== lastWorktreeTabCount) {
        lastRepoCount = repoCount
        lastWorktreeTabCount = worktreeTabCount
        schedule()
      }
    }),
    () => {
      if (timer) {
        clearTimeout(timer)
      }
    }
  )
}
