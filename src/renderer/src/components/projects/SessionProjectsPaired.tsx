import { FolderKanban, Monitor } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SessionProjectListEntry } from '../../../../shared/session-project-cli'
import { usePairedProjects } from './use-paired-projects'

function PairedProjectCard({ project }: { project: SessionProjectListEntry }): React.JSX.Element {
  const needsYou = project.threads?.byStatus.needsYou ?? 0
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2"
      data-paired-project={project.folderId}
    >
      <span className="flex items-center gap-2">
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
      </span>
      {project.company ? (
        <span className="truncate text-[11px] text-muted-foreground">{project.company}</span>
      ) : null}
      <span className="text-[11px] text-muted-foreground">
        {project.threads
          ? translate('projects.paired.threads', '{{count}} threads', {
              count: project.threads.total
            })
          : translate('projects.paired.threadsUnknown', 'Threads not counted')}
        {needsYou
          ? ` · ${translate('projects.paired.needsYou', '{{count}} need you', { count: needsYou })}`
          : ''}
      </span>
    </div>
  )
}

/** Each paired computer's projects, read-only; open that computer to work in one. */
export function SessionProjectsPaired(): React.JSX.Element | null {
  const computers = usePairedProjects()
  if (computers.length === 0) {
    return null
  }
  return (
    <>
      {computers.map((computer) => (
        <section
          key={computer.environmentId}
          aria-label={translate('projects.paired.on', 'On {{name}}', { name: computer.name })}
          data-paired-projects={computer.environmentId}
        >
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Monitor className="size-3.5 text-muted-foreground" aria-hidden />
            {translate('projects.paired.on', 'On {{name}}', { name: computer.name })}
          </h2>
          {computer.error ? (
            <p className="text-sm text-muted-foreground" role="status">
              {translate('projects.paired.failed', 'Could not list its projects: {{reason}}', {
                reason: computer.error
              })}
            </p>
          ) : computer.projects === null ? (
            <p className="text-sm text-muted-foreground">
              {translate('projects.paired.loading', 'Reading its projects…')}
            </p>
          ) : computer.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {translate('projects.paired.empty', 'No projects there.')}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {computer.projects.map((project) => (
                <li key={project.folderId}>
                  <PairedProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  )
}
