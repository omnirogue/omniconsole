import { useEffect } from 'react'
import { noteBackofficeActivity } from '@/lib/backoffice-polling-activity'
import { selectBackofficePeerProject, useBackofficeWorkStore } from './backoffice-work-store'

export function useVisiblePeerProject(project: string): void {
  const scope = useBackofficeWorkStore((state) => state.scope)
  useEffect(() => {
    if (!scope || !project) {
      return
    }
    noteBackofficeActivity()
    void selectBackofficePeerProject(scope, project)
    return () => {
      void selectBackofficePeerProject(scope, null)
    }
  }, [scope, project])
}
