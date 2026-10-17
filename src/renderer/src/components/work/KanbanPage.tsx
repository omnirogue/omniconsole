import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { translate } from '@/i18n/i18n'
import { useSessionFollowUpRows } from '@/lib/session-follow-up-rows'
import { BackofficeWorkBoardWorkspace } from '@/components/task-page/backoffice/backoffice-work-board-workspace'
import {
  invalidateBackofficeWork,
  useBackofficeWorkViews
} from '@/components/task-page/backoffice/backoffice-work-store'
import { useBackofficeArchive } from '@/components/task-page/hooks/use-task-page-backoffice'
import { valueOf } from '@/components/task-page/backoffice/backoffice-work-reads'

/**
 * Work → Kanban: the board people were reaching through Tasks → Kanban, as its own
 * destination. Both entry points share the board and its task detail sheet.
 */
export default function KanbanPage({
  embedded = false,
  visible = true
}: { embedded?: boolean; visible?: boolean } = {}): React.JSX.Element {
  const scope = useHandoffScope()
  return <KanbanAccount key={scope} scope={scope} embedded={embedded} visible={visible} />
}

function KanbanAccount({
  scope,
  embedded,
  visible
}: {
  scope: string
  embedded: boolean
  visible: boolean
}): React.JSX.Element {
  const followUps = useSessionFollowUpRows()
  const projected = useBackofficeWorkViews(scope, visible, followUps)
  const feed = valueOf(projected.reads.todo)
  const archive = useBackofficeArchive(invalidateBackofficeWork)
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="kanban-page"
    >
      {embedded ? null : (
        <header className="border-b px-6 py-4">
          <h1 className="text-lg font-semibold">{translate('nav.kanban', 'Kanban')}</h1>
          <p className="text-xs text-muted-foreground">
            {translate(
              'workKanban.pageDescription',
              'Your tasks by outcome stage. Move a card to tell the hub where the work stands.'
            )}
          </p>
        </header>
      )}
      <BackofficeWorkBoardWorkspace
        scope={scope}
        rows={projected.views.all}
        names={projected.names}
        viewer={feed?.employeeId ?? null}
        baseUrl={feed?.baseUrl ?? null}
        itemActions={{ onArchiveItem: archive.archive, archivePending: archive.pending }}
        onRefresh={invalidateBackofficeWork}
      />
    </div>
  )
}
