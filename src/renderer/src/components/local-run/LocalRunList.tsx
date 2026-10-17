import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalRunDraft } from '../../../../shared/local-run-graph'
import type { LocalRunSnapshot } from '../../../../shared/local-run-types'
import type { BuildReviewPipelineSnapshot } from '../../../../shared/build-review-pipeline'
import { localGraphStageLabel } from './local-run-labels'

export type LocalRunSelection =
  | { kind: 'run'; id: string }
  | { kind: 'pipeline'; id: string }
  | { kind: 'draft'; id: string }
  | { kind: 'new' }

/**
 * Everything this desktop is running or has saved, in one list: local Runs, Build +
 * Review pipelines, and saved graphs. No queue, no claims, nobody else's work.
 */
export function LocalRunList({
  runs,
  pipelines,
  drafts,
  selection,
  onSelect,
  onRemoveDraft
}: {
  runs: readonly LocalRunSnapshot[]
  pipelines: readonly BuildReviewPipelineSnapshot[]
  drafts: readonly LocalRunDraft[]
  selection: LocalRunSelection | null
  onSelect: (selection: LocalRunSelection) => void
  onRemoveDraft: (id: string) => void
}) {
  const selected = (kind: LocalRunSelection['kind'], id?: string) =>
    selection?.kind === kind && (kind === 'new' || ('id' in selection && selection.id === id))
  return (
    <nav aria-label={translate('auto.components.local-run.List.label', 'Local runs')}>
      <ul className="space-y-1">
        {runs.map((run) => (
          <li key={run.id} className="flex min-w-0 items-center gap-1">
            <Row
              selected={selected('run', run.id)}
              onSelect={() => onSelect({ kind: 'run', id: run.id })}
              title={run.graph.nodes.length ? run.workspacePath : run.id}
              detail={`${localGraphStageLabel(run.stage)} · ${run.graph.nodes.length} ${translate(
                'auto.components.local-run.List.steps',
                'steps'
              )}`}
            />
          </li>
        ))}
        {pipelines.map((pipeline) => (
          <li key={pipeline.id} className="flex min-w-0 items-center gap-1">
            <Row
              selected={selected('pipeline', pipeline.id)}
              onSelect={() => onSelect({ kind: 'pipeline', id: pipeline.id })}
              title={pipeline.objective || pipeline.id}
              detail={`${translate(
                'auto.components.local-run.List.buildReview',
                'Build + Review'
              )} · ${localGraphStageLabel(pipeline.stage)}`}
            />
          </li>
        ))}
        {drafts.map((draft) => (
          <li key={draft.id} className="flex min-w-0 items-center gap-1">
            <Row
              selected={selected('draft', draft.id)}
              onSelect={() => onSelect({ kind: 'draft', id: draft.id })}
              title={draft.title}
              detail={`${translate('auto.components.local-run.List.saved', 'Saved graph')} · ${
                draft.graph.workspacePath
              }`}
            />
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              aria-label={`${translate('auto.components.local-run.List.remove', 'Delete')} ${draft.title}`}
              onClick={() => onRemoveDraft(draft.id)}
            >
              {translate('auto.components.local-run.List.remove', 'Delete')}
            </Button>
          </li>
        ))}
      </ul>
      {runs.length === 0 && pipelines.length === 0 && drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.local-run.List.empty',
            'No graphs yet. Start one from a template on any workspace folder.'
          )}
        </p>
      )}
    </nav>
  )
}

function Row({
  selected,
  onSelect,
  title,
  detail
}: {
  selected: boolean
  onSelect: () => void
  title: string
  detail: string
}) {
  return (
    <Button
      variant="ghost"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'h-auto min-w-0 flex-1 flex-col items-start gap-0.5 whitespace-normal px-2 py-1.5 text-left',
        selected && 'bg-accent'
      )}
    >
      <span className="w-full truncate text-sm">{title}</span>
      <span className="w-full truncate text-xs text-muted-foreground">{detail}</span>
    </Button>
  )
}
