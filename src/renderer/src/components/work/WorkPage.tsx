import { WORK_PAGE_SECTIONS } from './work-page-sections'
import { RoomsPage } from '../rooms/RoomsPage'
import React, { useState } from 'react'
import { Building2, Files, Focus, LayoutDashboard, ListTodo, RefreshCw, Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { invalidateBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { WorkDispatchComposer } from './WorkDispatchComposer'
import { WorkCompaniesSection } from './WorkCompaniesSection'
import { WorkHappeningSection } from './WorkHappeningSection'
import { WorkNeedsYouSection } from './WorkNeedsYouSection'
import { WorkStatsSection } from './WorkStatsSection'
import { WorkStewardActivitySection } from './WorkStewardActivitySection'
import { WorkCleanupRunsSection } from './WorkCleanupRunsSection'
import { WorkOtherComputersSection } from './WorkOtherComputersSection'
import { WorkProjectsSection } from './WorkProjectsSection'
import { WorkArtifactsSection } from './WorkArtifactsSection'
import { openWorkDecisions } from '@/lib/open-work-decisions'

/**
 * Work — the home screen. Three questions, top down: what needs me, what is
 * happening, how are my companies doing. Everything here is a projection of
 * stores and reads that already exist (the pane snapshot, the console work feed,
 * the scorecard); nothing is computed twice.
 */
export default function WorkPage(): React.JSX.Element {
  const account = useAppStore((state) => state.activeOrcaProfileId)
  const environment = useAppStore(
    (state) =>
      `${state.settings?.backofficeEnv}:${state.settings?.backofficeLocalUrl}:${state.settings?.backofficeProductionUrl}`
  )
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const openAttentionPage = useAppStore((state) => state.openAttentionPage)
  const openCompaniesPage = useAppStore((state) => state.openCompaniesPage)
  const openArtifactsPage = useAppStore((state) => state.openArtifactsPage)
  const [revision, setRevision] = useState(0)
  const [roomsOpen, setRoomsOpen] = useState(false)
  if (roomsOpen && window.api.rooms) {
    return (
      <RoomsPage
        key={`${account}:${environment}`}
        api={window.api.rooms}
        close={() => setRoomsOpen(false)}
      />
    )
  }
  const sections = {
    dispatch: <WorkDispatchComposer />,
    projects: <WorkProjectsSection />,
    'needs-you': <WorkNeedsYouSection />,
    artifacts: <WorkArtifactsSection />,
    happening: <WorkHappeningSection />,
    steward: <WorkStewardActivitySection />,
    cleanup: <WorkCleanupRunsSection />,
    'other-computers': <WorkOtherComputersSection />,
    companies: <WorkCompaniesSection revision={revision} />,
    stats: <WorkStatsSection revision={revision} />
  }
  return (
    <div
      key={`${account}:${environment}`}
      data-testid="work-page"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <LayoutDashboard className="size-5" aria-hidden />
            {translate('work.nav', 'Work')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {translate(
              'work.subtitle',
              'What needs you, what is happening, how your companies are doing, and the figures behind them.'
            )}
          </p>
        </div>
        <nav
          aria-label={translate('work.quickLinks', 'Work quick links')}
          className="flex flex-wrap gap-1"
        >
          {window.api.rooms ? (
            <Button size="sm" variant="ghost" onClick={() => setRoomsOpen(true)}>
              {translate('rooms.title', 'Online Rooms')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={openArtifactsPage}>
            <Files className="size-3.5" aria-hidden />
            {translate('work.artifacts', 'Artifacts')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openWorkDecisions()}>
            <Scale className="size-3.5" aria-hidden />
            {translate('work.decisions', 'Decisions')}
          </Button>
          <Button size="sm" variant="ghost" onClick={openAttentionPage}>
            <Focus className="size-3.5" aria-hidden />
            {translate('work.focus', 'Focus')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openTaskPage({ taskSource: 'backoffice' })}
          >
            <ListTodo className="size-3.5" aria-hidden />
            {translate('work.tasks', 'Tasks')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openCompaniesPage()}>
            <Building2 className="size-3.5" aria-hidden />
            {translate('work.companies', 'Companies')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              invalidateBackofficeWork()
              setRevision((value) => value + 1)
            }}
            aria-label={translate('work.refresh', 'Refresh')}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {translate('work.refresh', 'Refresh')}
          </Button>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6">
        <div className="mx-auto max-w-5xl space-y-8">
          {WORK_PAGE_SECTIONS.map(({ id }) => {
            return (
              <React.Fragment key={id === 'dispatch' ? id : `${id}:${revision}`}>
                {sections[id]}
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}
