import { SessionDetailsConnected } from '@/components/next-action/advanced/SessionDetailsConnected'
import { useSessionDetailsFacts } from '@/components/next-action/use-session-details-facts'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RunsOnDispatch } from '@/components/next-action/advanced/RunsOnDispatch'
import { useFleetDispatch } from '@/components/next-step/use-fleet-dispatch'
import { useNextStepTask } from '@/components/next-step/use-next-step-task'
import { dispatchToFleet } from '@/components/next-step/add-next/dispatch-to-fleet'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { nextStepAgents } from '../../../../../shared/next-step-draft'
import {
  conversationFleetProgress,
  conversationFleetSettled
} from '@/lib/conversation-fleet-progress'
import { matchesConversationFleetSource } from '@/lib/conversation-fleet-sidebar'
import {
  conversationFleetScope,
  useConversationFleetRuns,
  useConversationFleetStore
} from '@/store/conversation-fleet-store'
import type { NextStepDraft } from '../../../../../shared/next-step-draft'
import type { SessionBulkOutcome } from './session-bulk-outcome'
import type { SessionBulkItem } from './SessionBulkNextStep'

type Controller = ReturnType<typeof useFleetDispatch> & {
  linkedTask: { id: string; title: string } | null
  deliverables: ReturnType<typeof useNextStepTask>['deliverables']
}
type Result = {
  key: string
  state: 'waiting' | 'sending' | 'sent' | 'not-sent' | 'unconfirmed'
  message?: string
}

/** The batch reports every conversation itself; the shared body has nothing to close. */
const noop = (): void => {}

function resultLabel(state: Result['state']): string {
  return {
    waiting: translate('conversations.bulkDispatchWaiting', 'Waiting'),
    sending: translate('conversations.bulkDispatchSending', 'Sending…'),
    sent: translate('conversations.bulkDispatchSent', 'Sent'),
    'not-sent': translate('conversations.bulkDispatchFailed', 'Not sent'),
    unconfirmed: translate('conversations.bulkDispatchUnconfirmed', 'Not confirmed')
  }[state]
}

function Target({
  item,
  register
}: {
  item: SessionBulkItem
  register: (key: string, value: Controller | null, signature?: string) => void
}) {
  const fleet = useFleetDispatch({ kind: 'session', session: item.session })
  const task = useNextStepTask({ kind: 'session', session: item.session })
  const controller = fleet
    ? { ...fleet, linkedTask: task.linked, deliverables: task.deliverables }
    : null
  const signature = JSON.stringify([fleet, task.linked, task.workspacePath])
  useEffect(() => {
    register(item.key, controller, signature)
  })
  useEffect(() => () => register(item.key, null), [item.key, register])
  return null
}

function BulkFleetDispatch({
  items,
  onFinished
}: {
  items: readonly SessionBulkItem[]
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}): React.JSX.Element {
  const snapshot = useRef([...items])
  const controllers = useRef(new Map<string, Controller>())
  const signatures = useRef(new Map<string, string>())
  const running = useRef(false)
  const cancelled = useRef(false)
  const [, setReadyRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Result[]>(() =>
    snapshot.current.map((item) => ({ key: item.key, state: 'waiting' }))
  )
  useConversationFleetRuns()
  const first = snapshot.current[0]
  const firstController = first ? controllers.current.get(first.key) : null
  useEffect(
    () => () => {
      cancelled.current = true
    },
    []
  )
  const register = useCallback(
    (key: string, value: Controller | null, signature?: string): void => {
      const changed = value !== null && signatures.current.get(key) !== signature
      if (value) {
        controllers.current.set(key, value)
        signatures.current.set(key, signature ?? '')
      } else {
        controllers.current.delete(key)
        signatures.current.delete(key)
      }
      if (changed) {
        setReadyRevision((revision) => revision + 1)
      }
    },
    []
  )
  const active = (item: SessionBulkItem): boolean =>
    useConversationFleetStore
      .getState()
      .runs.filter((run) => matchesConversationFleetSource(run, item.session))
      .some(
        (run) => !conversationFleetSettled(conversationFleetProgress(run.jobs, run.verified).phase)
      )
  const submit = async (
    draft: NextStepDraft,
    machineId: string | undefined,
    acknowledged: boolean
  ) => {
    const consentRequired = snapshot.current.length > 1 || nextStepAgents(draft).length > 1
    if (running.current || (consentRequired && !acknowledged)) {
      return
    }
    running.current = true
    setBusy(true)
    cancelled.current = false
    const batchScope = conversationFleetScope()
    const outcomes: SessionBulkOutcome[] = []
    for (const item of snapshot.current) {
      if (cancelled.current || conversationFleetScope() !== batchScope) {
        break
      }
      const controller = controllers.current.get(item.key)
      if (!controller || active(item)) {
        const message = translate('conversations.bulkNotSent', 'not sent')
        outcomes.push({ key: item.key, label: item.label, ok: false, message })
        setResults((rows) =>
          rows.map((row) => (row.key === item.key ? { ...row, state: 'not-sent' } : row))
        )
        continue
      }
      setResults((rows) =>
        rows.map((row) => (row.key === item.key ? { ...row, state: 'sending' } : row))
      )
      try {
        const targetDraft: NextStepDraft = {
          ...draft,
          placement: null,
          destinationWorktreeId: undefined,
          handoff: {
            ...draft.handoff,
            task: controller.linkedTask,
            deliverables: controller.deliverables
          }
        }
        const dispatched = await dispatchToFleet({
          session: item.session,
          draft: targetDraft,
          linkedTask: controller.linkedTask,
          target: { machineId: machineId ?? null },
          fanoutAcknowledged: acknowledged,
          ports: controller
        })
        if (conversationFleetScope() !== batchScope) {
          cancelled.current = true
          throw new Error(
            translate(
              'conversations.bulkDispatchPersonChanged',
              'The signed-in person changed; this dispatch may have been accepted under the original account.'
            )
          )
        }
        if ('refusal' in dispatched) {
          outcomes.push({
            key: item.key,
            label: item.label,
            ok: false,
            message: dispatched.refusal
          })
          setResults((rows) =>
            rows.map((row) =>
              row.key === item.key
                ? { ...row, state: 'not-sent', message: dispatched.refusal }
                : row
            )
          )
          continue
        }
        outcomes.push({ key: item.key, label: item.label, ok: true })
        setResults((rows) =>
          rows.map((row) => (row.key === item.key ? { ...row, state: 'sent' } : row))
        )
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        const message = translate(
          'conversations.bulkDispatchUnconfirmedDetail',
          'Dispatch not confirmed: {{detail}} Check its existing task and receipt before retrying.',
          { detail }
        )
        outcomes.push({ key: item.key, label: item.label, ok: false, message })
        setResults((rows) =>
          rows.map((row) =>
            row.key === item.key ? { ...row, state: 'unconfirmed', message } : row
          )
        )
      }
    }
    for (const item of snapshot.current.slice(outcomes.length)) {
      outcomes.push({
        key: item.key,
        label: item.label,
        ok: false,
        message: translate('conversations.bulkNotSent', 'not sent')
      })
    }
    running.current = false
    setBusy(false)
    onFinished(outcomes)
  }
  return (
    <div className="w-[min(620px,calc(100vw-2rem))] space-y-2 p-3">
      {snapshot.current.map((item) => (
        <Target key={item.key} item={item} register={register} />
      ))}
      {first && firstController ? (
        <RunsOnDispatch
          session={first.session}
          onSent={noop}
          batch={{ count: snapshot.current.length, onSubmit: submit }}
        />
      ) : null}
      <div className="space-y-1 text-xs" aria-live="polite">
        {results.map((result) => (
          <p key={result.key}>
            {snapshot.current.find((item) => item.key === result.key)?.label}:{' '}
            {resultLabel(result.state)}
            {result.message ? ` · ${result.message}` : ''}
          </p>
        ))}
      </div>
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          cancelled.current = true
          if (!busy) {
            onFinished(
              snapshot.current.map((item) => ({
                key: item.key,
                label: item.label,
                ok: false,
                message: translate('conversations.bulkNotSent', 'not sent')
              }))
            )
          }
        }}
      >
        {translate('nextStep.cancel', 'Cancel')}
      </Button>
    </div>
  )
}

export function SessionBulkFleetDispatch(props: {
  items: readonly SessionBulkItem[]
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}): React.JSX.Element | null {
  const first = props.items[0]
  return first ? <BulkSessionDetails {...props} first={first} /> : null
}

function BulkSessionDetails({
  first,
  ...props
}: {
  first: SessionBulkItem
  items: readonly SessionBulkItem[]
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}) {
  const chain = useSessionChainForRow(first.session.rowKey)
  const facts = useSessionDetailsFacts(first.session, chain)
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {translate('nextAction.sessionDetails', 'Session details')}
      </h4>
      <SessionDetailsConnected
        facts={facts}
        chain={chain}
        runsOnMenu={
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={translate('nextAction.runsOn', 'Runs on')}
              >
                {facts.runsOn} ▾
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(48rem,90vw)] max-h-[80vh] overflow-y-auto scrollbar-sleek"
              align="start"
            >
              {open && <BulkFleetDispatch {...props} />}
            </PopoverContent>
          </Popover>
        }
      />
    </div>
  )
}
