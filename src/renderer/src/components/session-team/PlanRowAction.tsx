import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  conversationPlanLabel,
  conversationStateLabel,
  conversationState
} from '@/lib/conversation-state'
import { conversationPlanHistory } from '@/lib/conversation-plan-history'
import { sessionOutcomeConnection } from '@/lib/session-outcome-connection'
import { currentSessionRunRowState, type SessionRunRowState } from '@/lib/session-run-row-state'
import type { PursuitSidebarTreeRow } from '@/lib/session-sidebar-tree-rows'
import { cn } from '@/lib/utils'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { sessionOutcomePlanState } from '../../../../shared/session-outcome-plan-state'
import { ViewPlanButton } from './ViewPlanButton'

const NO_SEATS: readonly PursuitSidebarTreeRow[] = []

export function PlanRowAction({
  chain,
  run,
  seats = NO_SEATS,
  onOpenSeat
}: {
  chain: SessionChain
  /** The reading the row already took; read here only where no row did. */
  run?: SessionRunRowState | null
  seats?: readonly PursuitSidebarTreeRow[]
  onOpenSeat?: (row: PursuitSidebarTreeRow) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [files, setFiles] = useState<ReadonlyMap<string, readonly string[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  if (!chain.outcomeSet) {
    return null
  }
  const ready = sessionOutcomePlanState(chain) === 'plan-ready'
  const reading = run ?? currentSessionRunRowState(chain)
  const state = conversationState({ chain, state: null, waiting: false, needsYou: false })
  return (
    <div className="min-w-0 text-xs" data-work-plan-row={chain.id} data-run-phase={reading.phase}>
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={cn(
            reading.phase === 'needs-you' && 'font-medium text-agent-question-text',
            reading.phase === 'failed' && 'text-destructive'
          )}
        >
          {reading.phase === 'active' ? conversationStateLabel(state) : reading.headline}
        </span>
        {ready && <ViewPlanButton chain={chain} />}
        {ready && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async (event) => {
              event.stopPropagation()
              setBusy(true)
              setError(null)
              try {
                const connection = await sessionOutcomeConnection(chain).negotiate()
                const result = await connection.call<{ reference: { shareUrl: string } }>(
                  'workPlan.publish',
                  { id: chain.id }
                )
                setShareUrl(result.reference.shareUrl)
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure))
              } finally {
                setBusy(false)
              }
            }}
          >
            {translate('workPlan.publish', 'Publish')}
          </Button>
        )}
        {shareUrl && (
          <a href={shareUrl} target="_blank" rel="noreferrer">
            {translate('workPlan.published', 'Published plan')}
          </a>
        )}
      </div>
      {/* Why here: the row shows one clause; the request's why, or the full diagnostic, reads in full only once opened. */}
      {reading.detail ? (
        <p className="whitespace-pre-line text-muted-foreground" data-run-detail="">
          {reading.detail}
        </p>
      ) : null}
      <p className="truncate text-muted-foreground" title={conversationPlanLabel(chain)}>
        {conversationPlanLabel(chain)}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={async (event) => {
          event.stopPropagation()
          setExpanded(!expanded)
          if (expanded) {
            return
          }
          setError(null)
          try {
            const connection = await sessionOutcomeConnection(chain).negotiate()
            const entries = await Promise.all(
              chain.steps.map(async (step) => {
                const result = await connection.call<{ files: string[] }>(
                  'sessionChain.outputFiles',
                  {
                    workspacePath: chain.workspacePath,
                    chainId: chain.id,
                    stepId: step.id
                  }
                )
                return [step.id, result.files] as const
              })
            )
            setFiles(new Map(entries))
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        }}
      >
        {translate('workPlan.seatsHistory', 'Seats and plan history')}
      </Button>
      {expanded && (
        <div className="space-y-2 border-l pl-3">
          {seats.map((row) => (
            <div key={row.session.rowKey}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!onOpenSeat}
                onClick={() => onOpenSeat?.(row)}
              >
                {row.session.label}
              </Button>
              <span>
                {conversationStateLabel(
                  row.pursuitState ??
                    conversationState({
                      state: row.state,
                      needsYou: row.attention !== null,
                      waiting: row.waitingUntil !== null
                    })
                )}
              </span>
            </div>
          ))}
          {conversationPlanHistory(chain, files).map((version) => (
            <details key={version.version}>
              <summary>
                {translate('workPlan.historyVersion', 'Plan v{{version}}', {
                  version: version.version
                })}
              </summary>
              {version.steps.map((step) => (
                <p key={step.id}>
                  {step.id} · {step.status}
                </p>
              ))}
              {version.attempts.map((attempt) => (
                <p key={attempt.id}>
                  {attempt.id} · {attempt.state}
                </p>
              ))}
              {version.verdicts.map((verdict) => (
                <p key={verdict.consumptionKey}>
                  {verdict.stepId} · {JSON.stringify(verdict.verdict)}
                </p>
              ))}
              {version.files.map((file) => (
                <p key={file}>{file}</p>
              ))}
            </details>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
