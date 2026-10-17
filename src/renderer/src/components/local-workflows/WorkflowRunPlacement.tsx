import { translate } from '@/i18n/i18n'
import type {
  WorkflowPlacement,
  WorkflowPlacementMode
} from '../../../../shared/local-workflow-placement'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

function modeLabel(mode: WorkflowPlacementMode): string {
  switch (mode) {
    case 'local':
      return translate('localWorkflow.run.placementModeLocal', 'this computer')
    case 'dispatched-seats':
      return translate('localWorkflow.run.placementModeDispatched', 'dispatched seats')
    case 'remote-runtime':
      return translate('localWorkflow.run.placementModeRemote', 'remote runtime')
  }
}

/** "Runs on mw0004 · dispatched seats · named · 0.10 load per core, read 12:03 · forced: …" */
export function workflowPlacementCaption(placement: WorkflowPlacement): string | null {
  const host = placement.host
  if (placement.fallback) {
    return translate(
      'localWorkflow.run.placementFallback',
      'Runs on this computer: the fleet could not take it ({{reason}})',
      { reason: placement.fallback }
    )
  }
  if (!host) {
    return null
  }
  return [
    translate('localWorkflow.run.placementHost', 'Runs on {{host}}', { host: host.name }),
    modeLabel(placement.mode),
    ...(placement.choice === 'named'
      ? [translate('localWorkflow.run.placementNamed', 'named')]
      : []),
    translate('localWorkflow.run.placementReading', '{{load}} load per core, read {{time}}', {
      load: host.loadPerCore.toFixed(2),
      time: new Date(host.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }),
    ...(placement.forced
      ? [
          translate('localWorkflow.run.placementForced', 'forced: {{reason}}', {
            reason: placement.forced
          })
        ]
      : [])
  ].join(' · ')
}

/** Where the run was placed and who asked for it; nothing for a run with neither. */
export function WorkflowRunPlacement({
  view
}: {
  view: Pick<LocalWorkflowView, 'placement' | 'requestedBy' | 'request'>
}) {
  const placement = view.placement ? workflowPlacementCaption(view.placement) : null
  const requested = view.requestedBy
    ? view.request
      ? translate('localWorkflow.run.requestedByWords', 'Requested by {{person}}: “{{request}}”', {
          person: view.requestedBy,
          request: view.request
        })
      : translate('localWorkflow.run.requestedBy', 'Requested by {{person}}', {
          person: view.requestedBy
        })
    : null
  if (!placement && !requested) {
    return null
  }
  return (
    <div className="flex min-w-0 basis-full flex-col gap-0.5 text-xs text-muted-foreground">
      {placement ? (
        <span className="truncate" title={placement}>
          {placement}
        </span>
      ) : null}
      {requested ? (
        <span className="truncate" title={requested}>
          {requested}
        </span>
      ) : null}
    </div>
  )
}
