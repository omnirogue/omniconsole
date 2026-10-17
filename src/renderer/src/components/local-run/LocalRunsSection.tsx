import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { buildReviewGraphView } from '@/lib/local-graph-build-review'
import { localRunGraphView } from '@/lib/local-graph-view'
import {
  localRunDraftFromSaved,
  newLocalRunDraft,
  type LocalRunCanvasDraft
} from '@/lib/local-run-draft'
import { useLocalRunNavigation } from '@/lib/local-run-navigation'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { LocalRunDraftEditor } from './LocalRunDraftEditor'
import { LocalRunGraphPanel } from './LocalRunGraphPanel'
import { LocalRunList, type LocalRunSelection } from './LocalRunList'
import { localRunWorkspaceByPath, localRunWorkspaceOptions } from './local-run-workspaces'
import { useLocalRunDrafts } from './use-local-run-drafts'
import { useLocalRuns } from './use-local-runs'

/**
 * The Local runs section: everything this desktop runs itself, beside the console's
 * workflows. Local Runs and Build + Review pipelines are drawn by the same canvas;
 * saved graphs open in draft mode. It never lists work from a queue.
 */
export function LocalRunsSection({ onAdmit }: { onAdmit: (composer: WorkflowDraft) => void }) {
  const { runs, error, applyRun, refresh } = useLocalRuns()
  const pipelinesById = useAppStore((state) => state.buildReview.pipelinesById)
  const refreshPipelines = useAppStore((state) => state.buildReview.refreshAll)
  const worktrees = useAllWorktrees()
  const folders = useAppStore((state) => state.folderWorkspaces)
  const savedDrafts = useLocalRunDrafts()
  const navigation = useLocalRunNavigation()
  const workspaces = useMemo(
    () => localRunWorkspaceOptions(worktrees, folders),
    [worktrees, folders]
  )
  const [selection, setSelection] = useState<LocalRunSelection | null>(null)
  const [draft, setDraft] = useState<LocalRunCanvasDraft | null>(null)
  useEffect(() => {
    void refreshPipelines()
  }, [refreshPipelines])
  // Why keyed on requestedAt: a person can ask for a graph on a workspace while the
  // section is already open, and that request must win over the current selection.
  useEffect(() => {
    if (!navigation.open) {
      return
    }
    const workspace = navigation.workspacePath
      ? localRunWorkspaceByPath(workspaces, navigation.workspacePath)
      : null
    if (workspace) {
      setDraft(
        newLocalRunDraft({
          path: workspace.path,
          selector: workspace.value,
          kind: workspace.kind
        })
      )
      setSelection({ kind: 'new' })
    }
  }, [navigation.open, navigation.requestedAt, navigation.workspacePath, workspaces])
  const pipelines = useMemo(
    () => Object.values(pipelinesById).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [pipelinesById]
  )
  const startDraft = () => {
    const workspace = workspaces[0]
    if (!workspace) {
      return
    }
    setDraft(
      newLocalRunDraft({ path: workspace.path, selector: workspace.value, kind: workspace.kind })
    )
    setSelection({ kind: 'new' })
  }
  const openSaved = (id: string) => {
    const saved = savedDrafts.drafts.find((entry) => entry.id === id)
    if (!saved) {
      return
    }
    const workspace = localRunWorkspaceByPath(workspaces, saved.graph.workspacePath)
    setDraft(
      localRunDraftFromSaved(saved, {
        selector: workspace?.value ?? '',
        kind: workspace?.kind ?? 'folder'
      })
    )
    setSelection({ kind: 'draft', id })
  }
  const run = selection?.kind === 'run' ? runs.find((entry) => entry.id === selection.id) : null
  const pipeline =
    selection?.kind === 'pipeline' ? pipelines.find((entry) => entry.id === selection.id) : null
  const editing = draft && (selection?.kind === 'new' || selection?.kind === 'draft')
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {translate('auto.components.local-run.Section.title', 'Local runs')}
        </h2>
        <Button size="sm" variant="outline" disabled={!workspaces.length} onClick={startDraft}>
          <Plus />
          {translate('auto.components.local-run.Section.new', 'New graph')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.local-run.Section.help',
          'Graphs this computer runs itself, on any workspace folder. Git is optional; work admitted through the console lives in the Jobs tab.'
        )}
      </p>
      {(error || savedDrafts.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? savedDrafts.error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <LocalRunList
          runs={runs}
          pipelines={pipelines}
          drafts={savedDrafts.drafts}
          selection={selection}
          onSelect={(next) => {
            if (next.kind === 'draft') {
              openSaved(next.id)
              return
            }
            setSelection(next)
          }}
          onRemoveDraft={(id) => void savedDrafts.remove(id)}
        />
        <div className="min-w-0">
          {editing && draft && (
            <LocalRunDraftEditor
              draft={draft}
              workspaces={workspaces}
              onChange={setDraft}
              onSave={savedDrafts.save}
              onStarted={(started) => {
                applyRun(started)
                refresh()
                setSelection({ kind: 'run', id: started.id })
              }}
              onAdmit={onAdmit}
            />
          )}
          {run && (
            <LocalRunGraphPanel
              key={run.id}
              view={localRunGraphView(run)}
              run={run}
              onRunChanged={applyRun}
            />
          )}
          {pipeline && (
            <LocalRunGraphPanel
              key={pipeline.id}
              view={buildReviewGraphView(pipeline, {
                workspacePath:
                  workspaces.find((workspace) => workspace.value === pipeline.worktree)?.path ??
                  null
              })}
            />
          )}
          {!editing && !run && !pipeline && (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.local-run.Section.pick',
                'Pick a graph on the left, or start a new one.'
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
