import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openHttpLink } from '@/lib/http-link-routing'
import {
  publishSessionChains,
  setSessionChainEntry,
  useSessionChainForRow
} from '@/lib/session-chain-registry'
import { checkedAgoLabel } from '@/lib/session-run-event-wait'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import {
  chooseSessionOutcomeWait,
  type SessionOutcomeWaitChoice
} from '@/components/next-step/next-step-outcome-client'
import { sessionWaitsModel, type SessionWaitRow } from './session-waits-model'

const TICK_MS = 5_000
const HEADING = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

/** A clock for "checked 20 s ago" that only runs while the panel is on screen. */
function useNow(visible: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [visible])
  return now
}

function answerTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function StatusMark({ row }: { row: SessionWaitRow }): React.JSX.Element {
  switch (row.status) {
    case 'met':
      return <span className="text-status-success">✓</span>
    case 'continued':
      return (
        <span className="text-muted-foreground">
          ✓ {translate('sessionWaits.continuedAnyway', 'continued anyway')}
        </span>
      )
    case 'needs_you':
      return (
        <span className="font-medium text-agent-question">
          {translate('sessionWaits.needsYou', 'Needs you')}
        </span>
      )
    case 'unavailable':
      return (
        <span className="text-status-warning">
          {translate('sessionWaits.notScheduled', 'Follow-up not scheduled: {{reason}}', {
            reason:
              row.fact?.reason ??
              translate('sessionWaits.cannotCheck', 'the source cannot be checked.')
          })}
        </span>
      )
    case 'pending':
      return <span className="text-muted-foreground">○</span>
  }
}

function WaitChoices({
  chain,
  row
}: {
  chain: SessionChain
  row: SessionWaitRow
}): React.JSX.Element {
  const [busy, setBusy] = useState<SessionOutcomeWaitChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const choose = async (choice: SessionOutcomeWaitChoice): Promise<void> => {
    const set = chain.outcomeSet
    if (!set || busy) {
      return
    }
    setBusy(choice)
    setError(null)
    try {
      setSessionChainEntry(
        await chooseSessionOutcomeWait({
          id: chain.id,
          owner: chain,
          expectedRevision: set.revision,
          outcomeId: row.outcomeId,
          conditionId: row.conditionId,
          choice
        })
      )
      publishSessionChains()
      setConfirmCancel(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mt-1.5 space-y-1.5" data-session-wait-choices>
      {confirmCancel ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs">
            {translate('sessionWaits.cancelConfirm', 'Cancel the rest of this plan?')}
          </span>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => void choose('cancel')}
          >
            {translate('sessionWaits.cancelPlan', 'Cancel plan')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirmCancel(false)}
          >
            {translate('sessionWaits.keepPlan', 'Keep plan')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void choose('keep-waiting')}
          >
            {translate('sessionWaits.keepWaiting', 'Keep waiting')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void choose('continue')}
          >
            {translate('sessionWaits.continueAnyway', 'Continue anyway')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirmCancel(true)}
          >
            {translate('sessionWaits.cancel', 'Cancel')}
          </Button>
        </div>
      )}
      {busy ? (
        <p className="text-xs text-muted-foreground" role="status">
          {translate('sessionWaits.saving', 'Saving…')}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function WaitItem({
  chain,
  row,
  now,
  worktreeId
}: {
  chain: SessionChain
  row: SessionWaitRow
  now: number
  worktreeId: string
}): React.JSX.Element {
  const met = row.status === 'met' || row.status === 'continued'
  const excerpt = row.fact?.excerpt
  const link = row.link && /^https?:\/\//i.test(row.link) ? row.link : null
  return (
    <li className="text-xs" data-session-wait={row.status}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="font-medium">{row.who}</span>
        {row.where ? <span className="text-muted-foreground">{row.where}</span> : null}
        <StatusMark row={row} />
        {met && row.at ? <span className="text-muted-foreground">{answerTime(row.at)}</span> : null}
        {!met && row.fact ? (
          <span className="text-muted-foreground">
            {translate('sessionWaits.checked', 'checked {{ago}}', {
              ago: checkedAgoLabel(row.fact.checkedAt, now)
            })}
          </span>
        ) : null}
        {link ? (
          <Button
            type="button"
            size="xs"
            variant="link"
            className="h-auto px-0"
            onClick={(event) => openHttpLink(link, { worktreeId, modifierHeld: event.shiftKey })}
          >
            {translate('sessionWaits.open', 'Open')}
          </Button>
        ) : null}
      </div>
      {excerpt && (met || row.status === 'needs_you') ? (
        <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground">“{excerpt}”</p>
      ) : null}
      {row.status === 'needs_you' ? <WaitChoices chain={chain} row={row} /> : null}
    </li>
  )
}

/**
 * The plan a conversation filed around outside answers, read-only: who it waits on and what
 * runs after. Changing it goes through the chat, so this view offers no edit controls.
 */
export function SessionWaits({
  session,
  visible
}: {
  session: SidebarSession
  visible: boolean
}): React.JSX.Element | null {
  const chain = useSessionChainForRow(session.rowKey)
  const model = sessionWaitsModel(chain)
  const now = useNow(visible && model !== null)
  if (!chain || !model) {
    return null
  }
  return (
    <section className="mt-4 space-y-3 border-t border-border pt-3" data-session-waits>
      <div className="space-y-1.5">
        <h3 className={HEADING}>{translate('sessionWaits.waitingOn', 'Waiting on')}</h3>
        <ul className="space-y-2">
          {model.waits.map((row) => (
            <WaitItem
              key={row.key}
              chain={chain}
              row={row}
              now={now}
              worktreeId={session.worktreeId}
            />
          ))}
        </ul>
      </div>
      {model.after.length || model.finish ? (
        <div className="space-y-1.5">
          <h3 className={HEADING}>{translate('sessionWaits.then', 'Then')}</h3>
          <ol className="space-y-1.5 text-xs">
            {model.after.map((row) => (
              <li key={row.key} className="flex gap-1.5" data-session-then={row.done || undefined}>
                <span className="w-3 shrink-0 text-status-success">{row.done ? '✓' : ''}</span>
                <span className="line-clamp-2 min-w-0 break-words">“{row.text}”</span>
              </li>
            ))}
            {model.finish ? (
              <li className="flex gap-1.5">
                <span className="w-3 shrink-0" />
                <span>
                  {model.finish === 'end'
                    ? translate('sessionWaits.thenClose', 'Then: close this session')
                    : translate('sessionWaits.thenSave', 'Then: save this session')}
                </span>
              </li>
            ) : null}
          </ol>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {translate('sessionWaits.changeHint', 'Change this plan by telling the agent in chat.')}
      </p>
    </section>
  )
}
