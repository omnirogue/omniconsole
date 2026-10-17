import { translate } from '@/i18n/i18n'
import type { LocalGraphNode, LocalGraphView } from '@/lib/local-graph-view'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { BuildReviewWorkerCard } from '../build-review/BuildReviewWorkerCard'
import { LocalRunLivePane } from './LocalRunLivePane'
import {
  localRunNodeStateDot,
  localRunNodeStateLabel,
  localRunPresetLabel,
  localRunWorkerStatus
} from './local-run-labels'

/**
 * The node a person selected on the canvas, shown with the same worker card Build +
 * Review uses. A local Run node is not a builder or a reviewer, so the card is given
 * the node's own name and its state badge instead of a role it does not have.
 */
export function LocalRunNodeDetail({ view, node }: { view: LocalGraphView; node: LocalGraphNode }) {
  const running = node.state === 'running' || node.state === 'reviewing'
  return (
    <aside
      aria-label={translate('auto.components.local-run.NodeDetail.label', 'Step details')}
      className="min-w-0 space-y-3"
    >
      <BuildReviewWorkerCard
        worker={nodeWorker(node)}
        title={node.id}
        badge={localRunNodeStateLabel(node.state)}
        state={localRunNodeStateDot(node.state)}
        details={nodeDetails(node)}
      >
        {node.objective && (
          <div className="space-y-1">
            <h4 className="text-xs text-muted-foreground">
              {translate('auto.components.local-run.NodeDetail.objective', 'Objective')}
            </h4>
            <p className="whitespace-pre-wrap break-words text-sm">{node.objective}</p>
          </div>
        )}
        <div className="space-y-1">
          <h4 className="text-xs text-muted-foreground">
            {translate('auto.components.local-run.NodeDetail.produced', 'Produced files')}
          </h4>
          {node.producedFiles.length > 0 ? (
            <ul className="space-y-1 font-mono text-xs">
              {node.producedFiles.map((file) => (
                <li key={file} className="break-all">
                  {file}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.local-run.NodeDetail.noProduced',
                'This step has not produced any file yet.'
              )}
            </p>
          )}
        </div>
        {running && <LocalRunLivePane handle={node.terminalHandle} />}
      </BuildReviewWorkerCard>
      {view.source === 'build-review' && node.round !== null && (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.local-run.NodeDetail.round', 'Round')} {node.round}
        </p>
      )}
    </aside>
  )
}

function nodeWorker(node: LocalGraphNode): BuildReviewWorkerSnapshot {
  return {
    role: node.presetId === 'review' || node.presetId === 'verify' ? 'reviewer' : 'builder',
    choice: node.actor,
    ...(node.effortParity ? { effortParity: node.effortParity } : {}),
    status: localRunWorkerStatus(node.state),
    taskId: null,
    dispatchId: null,
    terminalHandle: node.terminalHandle,
    // Why null: a local Run stores produced files and a report PATH, not a report body.
    // Fabricating one here would put words in a worker's mouth.
    report: null,
    error: node.error
  }
}

function nodeDetails(node: LocalGraphNode): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    {
      label: translate('auto.components.local-run.NodeDetail.workspace', 'Workspace folder'),
      value: node.workspacePath
    }
  ]
  const push = (label: string, value: string | null) => {
    if (value) {
      rows.push({ label, value })
    }
  }
  push(
    translate('auto.components.local-run.NodeDetail.childWorkspace', 'Child workspace'),
    node.childWorkspaceName
  )
  push(
    translate('auto.components.local-run.NodeDetail.preset', 'Action'),
    node.presetId ? localRunPresetLabel(node.presetId) : null
  )
  push(translate('auto.components.local-run.NodeDetail.outputDir', 'Output folder'), node.outputDir)
  push(translate('auto.components.local-run.NodeDetail.manifest', 'Manifest'), node.manifestPath)
  push(translate('auto.components.local-run.NodeDetail.report', 'Report'), node.reportPath)
  push(
    translate('auto.components.local-run.NodeDetail.delivery', 'Delivered to card'),
    node.deliveryId
  )
  push(translate('auto.components.local-run.NodeDetail.gate', 'Gate'), node.gateQuestion)
  push(translate('auto.components.local-run.NodeDetail.terminal', 'Terminal'), node.terminalHandle)
  return rows
}
