import { useSessionTags } from './session-tags'
import { useLayoutEffect } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { ensureBuiltinUniversalProjects } from '@/lib/session-organization-person-changes'
import { useSessionFolders } from './session-folders'
import { useSessionSidebarView } from './session-sidebar-view'
import { useQuietWorkspace } from './quiet-workspace'
import { useWaitLater } from './wait-later-store'

export function usePersonalSidebarScope(): void {
  const scope = useHandoffScope()
  useLayoutEffect(() => {
    useSessionTags.getState().load()
    useSessionFolders.getState().load()
    if (
      typeof window !== 'undefined' &&
      typeof window.api?.ui?.mirrorSessionProjects === 'function'
    ) {
      ensureBuiltinUniversalProjects()
    }
    useSessionSidebarView.getState().load()
    useWaitLater.getState().load()
    useQuietWorkspace.getState().load()
  }, [scope])
}
