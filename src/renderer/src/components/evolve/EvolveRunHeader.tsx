import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  evolveStatusCommand,
  isEvolveRunActive,
  isHostedEvolveRun,
  type EvolveRunRecord
} from '../../../../shared/evolve-workflow'
import { evolvePhase } from '../../../../shared/evolve-workflow-status'
import { WorkflowRunPlacement } from '../local-workflows/WorkflowRunPlacement'
import { EvolveCopyText } from './EvolveCopyText'
import { evolveStateLabel, evolveStateVariant } from './evolve-run-text'
import { useEvolveRunAction } from './use-evolve-run'

/** State, where it runs, the ledger ids a person can copy, and Stop / Check again. */
export function EvolveRunHeader({ run }: { run: EvolveRunRecord }) {
  const action = useEvolveRunAction(run.id)
  const [confirmStop, setConfirmStop] = useState(false)
  const command = evolveStatusCommand(run)
  // Omnisi Cloud has no stop route for hosted runs.
  const canStop =
    isEvolveRunActive(run.state) &&
    Boolean(run.worker) &&
    !run.stopRequestedAt &&
    !isHostedEvolveRun(run)
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={evolveStateVariant(run.state)}
          className={
            run.state === 'unverifiable'
              ? 'border-status-warning-border bg-status-warning-background text-status-warning'
              : undefined
          }
        >
          {evolveStateLabel(run.state)}
        </Badge>
        <span className="text-sm">{evolvePhase(run)}</span>
        <span className="text-xs text-muted-foreground">
          {translate('evolve.hostAndSubmitter', 'on {{host}} · submitted by {{who}}', {
            host: run.host,
            who: run.submittedBy
          })}
        </span>
        <WorkflowRunPlacement
          view={{
            placement: run.placement,
            requestedBy: run.request.requestedBy,
            request: run.request.request
          }}
        />
      </div>
      <dl className="grid gap-x-3 gap-y-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
        <dt className="text-muted-foreground">{translate('evolve.ledgerRun', 'Ledger run')}</dt>
        <dd className="min-w-0">
          {run.ledgerRunId ? (
            <EvolveCopyText
              value={run.ledgerRunId}
              label={translate('evolve.ledgerRunId', 'ledger run id')}
            />
          ) : (
            <span className="text-muted-foreground">
              {translate('evolve.notSubmitted', 'Not submitted to the ledger yet')}
            </span>
          )}
        </dd>
        {command && (
          <>
            <dt className="text-muted-foreground">
              {translate('evolve.readCommand', 'Read it yourself')}
            </dt>
            <dd className="min-w-0 space-y-1">
              <EvolveCopyText
                value={command}
                label={translate('evolve.statusCommand', 'status command')}
              />
              <p className="text-muted-foreground">
                {translate('evolve.runOnHost', 'run on {{host}}', { host: run.host })}
              </p>
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {canStop && !confirmStop && (
          <Button
            size="sm"
            variant="outline"
            disabled={action.pending !== null}
            onClick={() => setConfirmStop(true)}
          >
            {translate('evolve.stop', 'Stop')}
          </Button>
        )}
        {canStop && confirmStop && (
          <div
            role="group"
            aria-label={translate('evolve.confirmStop', 'Confirm stop')}
            className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1"
          >
            <span className="text-xs">
              {translate(
                'evolve.stopQuestion',
                'Stop this run? The worker gets an interrupt and the ledger records it failed.'
              )}
            </span>
            <Button
              size="xs"
              variant="destructive"
              disabled={action.pending !== null}
              onClick={() => {
                setConfirmStop(false)
                void action.act('stop')
              }}
            >
              {translate('evolve.stopRun', 'Stop run')}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmStop(false)}>
              {translate('evolve.keepRunning', 'Keep running')}
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant={run.state === 'unverifiable' ? 'default' : 'ghost'}
          disabled={action.pending !== null}
          onClick={() => void action.act('refresh')}
        >
          {action.pending === 'refresh'
            ? translate('evolve.checking', 'Checking…')
            : translate('evolve.checkAgain', 'Check again')}
        </Button>
        {run.stopRequestedAt && isEvolveRunActive(run.state) && (
          <span className="text-xs text-muted-foreground">
            {translate('evolve.stopRequested', 'Stop requested')}
          </span>
        )}
      </div>
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </header>
  )
}
