import React, { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
  SessionProjectCard,
  sessionProjectFolders
} from '@/components/projects/SessionProjectsOverview'
import { useSessionProjectRows } from '@/components/projects/use-session-project-rows'
import { translate } from '@/i18n/i18n'
import { emptySessionFolderTally, sessionFolderTallies } from '@/lib/session-folder-rollup'
import { useAppStore } from '@/store'
import { WorkSectionTitle } from './WorkSectionTitle'

const CARD_LIMIT = 6

/** The projects with their roll-ups, so the home answers "where does work stand" per project. */
export function WorkProjectsSection(): React.JSX.Element | null {
  const openProjectsPage = useAppStore((state) => state.openProjectsPage)
  const { metadata, rows, classifications } = useSessionProjectRows()
  const active = useMemo(
    () => metadata.folders.filter((folder) => folder.section !== 'saved'),
    [metadata.folders]
  )
  const projects = useMemo(() => sessionProjectFolders(active), [active])
  const tallies = useMemo(
    () => sessionFolderTallies(active, rows, classifications),
    [active, rows, classifications]
  )
  if (projects.length === 0) {
    return null
  }
  // Why: the busiest projects first, so the strip shows where the person is needed.
  const listed = [...projects]
    .sort((a, b) => {
      const left = tallies.get(a.id) ?? emptySessionFolderTally()
      const right = tallies.get(b.id) ?? emptySessionFolderTally()
      return right.needsYou - left.needsYou || right.working - left.working
    })
    .slice(0, CARD_LIMIT)
  return (
    <section
      aria-label={translate('projects.nav', 'Projects')}
      data-work-projects={projects.length}
    >
      <WorkSectionTitle
        title={translate('projects.nav', 'Projects')}
        sub={translate('projects.overview.count', '{{count}} projects', { count: projects.length })}
        action={
          <Button size="xs" variant="ghost" onClick={openProjectsPage}>
            {translate('projects.page.back', 'All projects')}
          </Button>
        }
      />
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {listed.map((folder) => (
          <li key={folder.id}>
            <SessionProjectCard
              folder={folder}
              folders={active}
              tally={tallies.get(folder.id) ?? emptySessionFolderTally()}
              compact
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
