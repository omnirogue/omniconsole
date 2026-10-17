import React, { useMemo } from 'react'
import { FolderKanban, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionFolderTally } from '@/components/sidebar/session-folders/SessionFolderTally'
import { translate } from '@/i18n/i18n'
import {
  emptySessionFolderTally,
  sessionFolderRowState,
  type SessionFolderTally as Tally
} from '@/lib/session-folder-rollup'
import type { SessionFolder } from '@/lib/session-folders'
import { sessionProjectOverviewTallies } from '@/lib/session-project-overview-tallies'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import {
  isProjectFolder,
  projectFolderFor,
  sessionFolderChain
} from '../../../../shared/session-project-folder'
import { openProjectCreate } from './project-settings-dialog-store'
import { useSessionHostedReviewOpen } from './use-session-project-review'
import { SessionProjectThreadRows } from './SessionProjectThreadList'
import { SessionProjectsPaired } from './SessionProjectsPaired'
import type { SessionProjectRows } from './use-session-project-rows'
import { useProjectSessionDrop } from './use-project-session-drop'

/** Group-by project's rule: every top-level folder, or a company folder's children. */
export function sessionProjectFolders(folders: readonly SessionFolder[]): SessionFolder[] {
  return folders.filter(
    (folder) => folder.section !== 'saved' && isProjectFolder(folders, folder.id)
  )
}

export function SessionProjectCard({
  folder,
  folders,
  tally,
  compact = false
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
  tally: Tally
  compact?: boolean
}): React.JSX.Element {
  const openProjectPage = useAppStore((state) => state.openProjectPage)
  const configured = useSessionFolders((state) => Boolean(state.metadata.projects?.[folder.id]))
  const chain = sessionFolderChain(folders, folder.id)
  const company = chain.length > 1 ? chain[0] : undefined
  const drop = useProjectSessionDrop(folder.id)
  return (
    <button
      type="button"
      onClick={() => openProjectPage(folder.id)}
      {...drop.handlers}
      data-session-project-card={folder.id}
      data-session-project-configured={configured ? 'true' : 'false'}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border bg-card text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'px-3 py-2' : 'px-4 py-3',
        tally.needsYou > 0 && 'border-agent-question/40',
        drop.over && 'ring-2 ring-ring'
      )}
    >
      <span className="flex items-center gap-2">
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
        {configured ? null : (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {translate('projects.overview.notSetUp', 'Not set up')}
          </span>
        )}
      </span>
      {company ? (
        <span className="truncate text-[11px] text-muted-foreground">{company.name}</span>
      ) : null}
      <SessionFolderTally tally={tally} />
      {tally.reviewReady ? (
        <span
          className="text-[10px] text-muted-foreground"
          data-session-project-review-ready={tally.reviewReady}
        >
          {translate('projects.overview.reviewReady', '{{count}} ready for review', {
            count: tally.reviewReady
          })}
        </span>
      ) : null}
    </button>
  )
}

/** Every project with its roll-up, and what needs the person across all of them, first. */
export function SessionProjectsOverview({ data }: { data: SessionProjectRows }): React.JSX.Element {
  const { metadata, rows, classifications } = data
  const active = useMemo(
    () => metadata.folders.filter((folder) => folder.section !== 'saved'),
    [metadata.folders]
  )
  const projects = useMemo(() => sessionProjectFolders(active), [active])
  const hostedReviewOpen = useSessionHostedReviewOpen()
  const tallies = useMemo(
    () =>
      sessionProjectOverviewTallies({ ...metadata, folders: active }, rows, {
        classifications,
        hostedReviewOpen,
        workerParentByLeaf: data.workerParentByLeaf
      }),
    [active, metadata, rows, classifications, hostedReviewOpen, data.workerParentByLeaf]
  )
  const needsYou = useMemo<SessionProjectThread[]>(
    () =>
      rows.flatMap((row) =>
        !row.archived &&
        row.folderId &&
        projectFolderFor(active, row.folderId) &&
        sessionFolderRowState(row, classifications.get(row.session.rowKey)) === 'needsYou'
          ? [
              {
                row,
                status: 'needsYou' as const,
                isCoordinator: false,
                agent: row.session.agent,
                ...(row.session.hostId ? { host: row.session.hostId } : {}),
                lastActivityAt: null
              }
            ]
          : []
      ),
    [rows, active, classifications]
  )
  return (
    <div
      data-testid="session-projects-overview"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FolderKanban className="size-5" aria-hidden />
            {translate('projects.nav', 'Projects')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {translate(
              'projects.overview.subtitle',
              'Each project holds its threads and the context every one of them starts with.'
            )}
          </p>
        </div>
        <Button size="sm" onClick={openProjectCreate} data-session-project-create="">
          <Plus className="size-3.5" aria-hidden />
          {translate('projects.create.open', 'New project')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6">
        <div className="mx-auto max-w-5xl space-y-8">
          <section
            aria-label={translate('projects.status.needsYou', 'Needs you')}
            data-session-projects-needs-you={needsYou.length}
          >
            <h2 className="mb-2 text-sm font-semibold">
              {translate('projects.overview.needsYouCount', '{{count}} threads need you', {
                count: needsYou.length
              })}
            </h2>
            {needsYou.length > 0 ? (
              <SessionProjectThreadRows threads={needsYou} data={data} />
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                {translate('projects.overview.nothingNeedsYou', 'No project thread needs you.')}
              </p>
            )}
          </section>
          <section
            aria-label={translate('projects.nav', 'Projects')}
            data-session-projects-count={projects.length}
          >
            <h2 className="mb-2 text-sm font-semibold">
              {translate('projects.overview.count', '{{count}} projects', {
                count: projects.length
              })}
            </h2>
            {projects.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                {translate(
                  'projects.overview.empty',
                  'No projects yet. A project is a folder whose threads share repos, documents, instructions and agents.'
                )}
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((folder) => (
                  <li key={folder.id}>
                    <SessionProjectCard
                      folder={folder}
                      folders={active}
                      tally={tallies.get(folder.id) ?? emptySessionFolderTally()}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <SessionProjectsPaired />
        </div>
      </div>
    </div>
  )
}
