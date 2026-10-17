import { useState } from 'react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { translate as t } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { MenuTargets } from '@/components/next-step/add-next/MenuTargets'
import { DispatchCurrent } from '@/components/next-step/add-next/DispatchCurrent'
import { useAddNextSend } from '@/components/next-step/add-next/use-add-next-send'
import { useFleetDispatch } from '@/components/next-step/use-fleet-dispatch'
import { useNextStepTask } from '@/components/next-step/use-next-step-task'
import { useNextStepRecipients } from '@/components/next-step/use-next-step-recipients'
import { findNextStepWorkspaceId } from '@/components/next-step/next-step-placement'
import type { FleetTarget } from '@/components/next-step/add-next/dispatch-to-fleet'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../../shared/next-step-draft'

const noPreview = () => {}

/**
 * Several conversations behind one location control: the batch owns the sending, this body
 * only chooses where they run and carries the operator's own fan-out tick into it.
 */
export type RunsOnBatch = {
  /** How many conversations this one dispatch covers. */
  count: number
  onSubmit: (
    draft: NextStepDraft,
    machineId: string | undefined,
    fanoutAcknowledged: boolean
  ) => Promise<void>
}

/** Location uses the existing dispatch doors; it never edits the Up next controller. */
export function RunsOnDispatch({
  session,
  onSent,
  batch = null
}: {
  session: SidebarSession
  onSent: () => void
  /** Bulk Runs on: the same body, with the batch's own sender behind the buttons. */
  batch?: RunsOnBatch | null
}) {
  const subject = { kind: 'session' as const, session }
  const fleet = useFleetDispatch(subject)
  const task = useNextStepTask(subject)
  const [target, setTarget] = useState<FleetTarget | null>(null)
  const [placement, setPlacement] = useState<ExecutionHostId | null>(null)
  const [count, setCount] = useState(1)
  const [fanoutAcknowledged, setFanoutAcknowledged] = useState(false)
  const [batchSending, setBatchSending] = useState(false)
  const destination = useAppStore((state) =>
    placement ? findNextStepWorkspaceId(state, session.worktreeId, placement) : null
  )
  const local = useNextStepRecipients(
    destination
      ? { kind: 'session', session: { ...session, worktreeId: destination, hostId: placement } }
      : subject
  )
  const data = target ? fleet.recipients : local
  const agents = data.agents.phase === 'ready' ? data.agents.value : []
  const agent =
    agents.find(
      (entry) =>
        entry.id === session.agent.toLowerCase() ||
        entry.label.toLowerCase() === session.agent.toLowerCase()
    ) ??
    agents[0] ??
    null
  const sender = useAddNextSend({ subject, fleet, linkedTask: task.linked, onSent })
  // Why: a batch of conversations is itself a fan-out, whatever each conversation asks for.
  const batchCount = batch?.count ?? 1
  const fanout = target !== null && (count > 1 || batchCount > 1)
  // Why: an empty list while the fleet is still answering is not "no agent can run this".
  const checking = data.agents.phase === 'loading'
  // Why: the batch has no local workspace of its own; only a fleet machine can take it.
  const located = batch ? target !== null : Boolean(target) || Boolean(destination)
  const blocked =
    sender.pending ||
    sender.done ||
    batchSending ||
    checking ||
    // Why: pressing again before the filing the hub named is fixed fails in exactly the same way.
    sender.action !== null ||
    !agent ||
    !located ||
    (fanout && !fanoutAcknowledged)
  const run = async (end: NextStepDraft['end']) => {
    if (blocked || !agent) {
      return
    }
    const acknowledged = fanoutAcknowledged
    setFanoutAcknowledged(false)
    const draft: NextStepDraft = {
      ...emptyNextStepDraft(),
      end,
      placement,
      destinationWorktreeId: destination ?? undefined,
      recipients: Array.from({ length: target ? count : 1 }, () => ({
        kind: 'agent' as const,
        key: crypto.randomUUID(),
        agent: agent.id,
        presetId: null,
        rounds: 1,
        instructions: t(
          'upNext.dispatchContinue',
          'Continue the current work using the session context. Complete its outstanding request.'
        )
      }))
    }
    if (batch) {
      setBatchSending(true)
      try {
        await batch.onSubmit(draft, target?.machineId ?? undefined, acknowledged)
      } finally {
        setBatchSending(false)
      }
      return
    }
    await sender.send(draft, target, acknowledged)
  }
  return (
    <div className="space-y-2">
      <fieldset disabled={sender.pending || batchSending}>
        <MenuTargets
          inventory={fleet.inventory}
          fleetTarget={target}
          placement={placement}
          sourceWorktreeId={session.worktreeId}
          onFleetPreview={noPreview}
          onHostPreview={noPreview}
          onFleet={(next) => {
            setTarget(next)
            setPlacement(null)
            setFanoutAcknowledged(false)
            sender.clear()
            fleet.onMachineChange(next.machineId ?? undefined)
          }}
          onHost={(next) => {
            setPlacement(next)
            setTarget(null)
            setCount(1)
            setFanoutAcknowledged(false)
            sender.clear()
          }}
        />
        {target && (
          <label>
            {t('upNext.dispatchAgents', 'Agents for this dispatch')}
            <Input
              type="number"
              min={1}
              max={9}
              value={count}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value) && value >= 1 && value <= 9) {
                  setCount(value)
                  setFanoutAcknowledged(false)
                }
              }}
            />
          </label>
        )}
        {fanout && (
          <label className="flex gap-2">
            <input
              type="checkbox"
              name="fanout_ack"
              checked={fanoutAcknowledged}
              onChange={(event) => setFanoutAcknowledged(event.target.checked)}
            />
            {batchCount > 1
              ? t(
                  'upNext.fanoutConsentBatch',
                  'Dispatch {{sessions}} conversations at once, {{count}} agents each',
                  { sessions: batchCount, count }
                )
              : t('upNext.fanoutConsent', 'Run {{count}} agents in parallel for this dispatch', {
                  count
                })}
          </label>
        )}
      </fieldset>
      {batchCount > 1 && (
        <p className="text-xs text-muted-foreground">
          {t('upNext.dispatchBatchCount', 'Dispatches {{count}} selected conversations.', {
            count: batchCount
          })}
        </p>
      )}
      {(target || placement) && (
        <DispatchCurrent
          agent={agent}
          pending={blocked}
          checking={checking}
          onRun={(end) => void run(end)}
        />
      )}
      {sender.error && <p role="alert">{sender.error}</p>}
      {sender.action && (
        <a href={sender.action.href} target="_blank" rel="noreferrer">
          {sender.action.label}
        </a>
      )}
      {sender.note && <p role="status">{sender.note}</p>}
      {data.agents.phase === 'error' && <p role="alert">{data.agents.message}</p>}
    </div>
  )
}
