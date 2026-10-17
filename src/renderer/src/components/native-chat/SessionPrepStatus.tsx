import { Layers, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_PREP_RPC,
  type SessionPrepBatchView,
  type SessionPrepItemView
} from '../../../../shared/session-prep-types'
import { armSessionPrepUndoBypass } from './session-prep-composer-state'
import { SessionPrepReuseOffer } from './SessionPrepReuseOffer'
import { useSessionPrepStatus } from './use-session-prep-status'

function launchedCount(batch: SessionPrepBatchView): number {
  return batch.items.filter((item) => item.state === 'launched').length
}

function failedCount(batch: SessionPrepBatchView): number {
  return batch.items.filter((item) => item.state === 'failed').length
}

function nothingLaunched(batch: SessionPrepBatchView): boolean {
  return !batch.items.some(
    (item) => item.state === 'launched' || item.state === 'launching' || item.state === 'assigned'
  )
}

function countIn(batch: SessionPrepBatchView, state: SessionPrepItemView['state']): number {
  return batch.items.filter((item) => item.state === state).length
}

function reuseOffers(
  batch: SessionPrepBatchView
): (SessionPrepItemView & { reuse: NonNullable<SessionPrepItemView['reuse']> })[] {
  return batch.items.filter(
    (item): item is SessionPrepItemView & { reuse: NonNullable<SessionPrepItemView['reuse']> } =>
      item.state === 'awaiting-reuse' && item.reuse !== undefined
  )
}

/** "<title> — codex gpt-5.6-sol high effort → OmniRogue / Prototypes" */
function itemLaunchLine(item: SessionPrepItemView): string | null {
  if (!item.agent) {
    return null
  }
  const runsOn = [
    item.agent,
    item.model,
    item.host ? `on ${item.host}` : undefined,
    item.effort
      ? translate('sessionPrep.effort', '{{effort}} effort', { effort: item.effort })
      : undefined,
    item.agentTemplate
      ? translate('sessionPrep.agentTemplate', '· {{name}} template', { name: item.agentTemplate })
      : undefined
  ]
    .filter(Boolean)
    .join(' ')
  const line = `${item.title} — ${runsOn}`
  return item.folder ? `${line} → ${item.folder}` : line
}

// Why a tooltip: the line stays one short sentence; the reasons and each session's agent, effort
// and folder are there on hover.
function batchReasons(batch: SessionPrepBatchView): string | undefined {
  const reasons = [
    ...batch.notes,
    ...batch.items.flatMap((item) => (item.note ? [item.note] : [])),
    ...batch.items.flatMap((item) => itemLaunchLine(item) ?? []),
    ...batch.items.flatMap((item) =>
      item.routing
        ? [
            translate('sessionPrep.routingReason', '{{title}} · Routing {{status}}: {{reason}}', {
              title: item.title,
              status: item.routing.status,
              reason: item.routing.reason
            })
          ]
        : []
    )
  ]
  return reasons.length > 0 ? reasons.join('\n') : undefined
}

function Action({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="font-medium text-foreground hover:underline" onClick={onClick}>
      {label}
    </button>
  )
}

function batchCopy(batch: SessionPrepBatchView): { text: string; busy: boolean } {
  const count = batch.items.length
  const launched = launchedCount(batch)
  if (batch.state === 'planning') {
    return { text: translate('sessionPrep.planning', 'Planning sessions…'), busy: true }
  }
  if (batch.state === 'running') {
    return {
      text: translate(
        'sessionPrep.running',
        'Preparing {{count}} sessions · {{launched}} launched',
        { count, launched }
      ),
      busy: true
    }
  }
  if (batch.state === 'awaiting-confirm') {
    return {
      text: translate('sessionPrep.awaitingConfirm', '{{count}} sessions planned', { count }),
      busy: false
    }
  }
  if (batch.state === 'failed') {
    return { text: translate('sessionPrep.failed', 'Could not prepare sessions'), busy: false }
  }
  const failed = failedCount(batch)
  return {
    text:
      failed > 0
        ? translate(
            'sessionPrep.doneWithFailed',
            '{{launched}} sessions launched · {{failed}} not launched',
            { launched, failed }
          )
        : translate('sessionPrep.done', '{{launched}} sessions launched', { launched }),
    busy: false
  }
}

export function SessionPrepStatus({
  paneKey,
  draft,
  setDraft
}: {
  paneKey: string
  draft: string
  setDraft: (value: string) => void
}): React.JSX.Element | null {
  const batches = useSessionPrepStatus(paneKey)
  if (batches.length === 0) {
    return null
  }

  const undo = (batch: SessionPrepBatchView) => {
    void callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.cancel, { batchId: batch.id }).catch(
      () => undefined
    )
    if (draft === '') {
      setDraft(batch.request)
      armSessionPrepUndoBypass(paneKey, batch.request)
    }
  }
  const confirm = (batch: SessionPrepBatchView) => {
    void callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.confirm, { batchId: batch.id }).catch(
      () => undefined
    )
  }
  const cancel = (batch: SessionPrepBatchView) => {
    void callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.cancel, { batchId: batch.id }).catch(
      () => undefined
    )
  }

  return (
    <>
      {batches.map((batch) => {
        const copy = batchCopy(batch)
        const actions =
          batch.state === 'running' && nothingLaunched(batch)
            ? [{ label: translate('sessionPrep.undo', 'Undo'), run: () => undo(batch) }]
            : batch.state === 'awaiting-confirm'
              ? [
                  {
                    label: translate('sessionPrep.launchAll', 'Launch all'),
                    run: () => confirm(batch)
                  },
                  { label: translate('sessionPrep.cancel', 'Cancel'), run: () => cancel(batch) }
                ]
              : []
        const assigned = countIn(batch, 'assigned')
        const covered = countIn(batch, 'already-covered')
        return (
          <div key={batch.id}>
            <div
              data-session-prep-status={batch.state}
              title={batchReasons(batch)}
              className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              {copy.busy ? (
                <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" />
              ) : (
                <Layers className="size-3.5 shrink-0" />
              )}
              <span>{copy.text}</span>
              {assigned > 0 ? (
                <span>
                  {`· ${translate('sessionPrep.assigned', '{{count}} given to existing sessions', { count: assigned })}`}
                </span>
              ) : null}
              {covered > 0 ? (
                <span>
                  {`· ${translate('sessionPrep.alreadyCovered', '{{count}} already being done', { count: covered })}`}
                </span>
              ) : null}
              {batch.state !== 'failed' && batch.notes.length > 0 ? (
                <span>
                  {`· ${translate('sessionPrep.skipped', '{{count}} skipped', { count: batch.notes.length })}`}
                </span>
              ) : null}
              {actions.map((action) => (
                <Action key={action.label} label={action.label} onClick={action.run} />
              ))}
            </div>
            {reuseOffers(batch).map((item) => (
              <SessionPrepReuseOffer key={item.index} batchId={batch.id} item={item} />
            ))}
          </div>
        )
      })}
    </>
  )
}
