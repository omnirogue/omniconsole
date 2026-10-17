import React from 'react'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { SessionProjectPage } from './SessionProjectPage'
import { SessionProjectsOverview } from './SessionProjectsOverview'
import { useSessionProjectRows } from './use-session-project-rows'

/** The Projects view: one project's page, or the overview of every project when none is open. */
export default function SessionProjectsPage(): React.JSX.Element {
  const folderId = useAppStore((state) => state.activeProjectFolderId)
  const folder = useSessionFolders((state) =>
    folderId ? state.metadata.folders.find((entry) => entry.id === folderId) : undefined
  )
  const data = useSessionProjectRows()
  // Why the key: each project starts the page's own state (collapsed groups) afresh.
  return folder ? (
    <SessionProjectPage key={folder.id} folder={folder} data={data} />
  ) : (
    <SessionProjectsOverview data={data} />
  )
}
