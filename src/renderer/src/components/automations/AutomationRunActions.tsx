import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  buildAutomationApplyPrompt,
  type AutomationAction
} from '../../../../shared/automation-actions'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { runAutomationNowForTarget, type AutomationHostTarget } from './automation-host-client'
import {
  readAutomationApplyOutcomes,
  type AutomationApplyOutcome
} from './automation-apply-outcome'
import { getAutomationRunMessage } from './automation-run-content'
import type { AutomationTargetAvailability } from './automation-target-availability'
import { TypesafeAdvertisingActions } from './TypesafeAdvertisingActions'
import { TypesafeClassificationResult } from './TypesafeClassificationResult'

function kindLabel(kind: AutomationAction['kind']): string {
  return kind === 'pause'
    ? translate('auto.components.automations.AutomationRunActions.pause', 'Pause')
    : translate('auto.components.automations.AutomationRunActions.activate', 'Turn on')
}

/** Button copy after a click: never an id, JSON or screen text (Sal, 2026-09-20). */
function outcomeLabel(kind: AutomationAction['kind'], outcome: AutomationApplyOutcome): string {
  const number = outcome.runNumber ?? '?'
  switch (outcome.state) {
    case 'verifying':
      return kind === 'pause'
        ? translate(
            'auto.components.automations.AutomationRunActions.pauseVerifying',
            'Pause sent · verifying…'
          )
        : translate(
            'auto.components.automations.AutomationRunActions.activateVerifying',
            'Turn-on sent · verifying…'
          )
    case 'applied':
      return kind === 'pause'
        ? translate('auto.components.automations.AutomationRunActions.paused', 'Paused ✓')
        : translate('auto.components.automations.AutomationRunActions.activated', 'Turned on ✓')
    case 'failed':
      return translate(
        'auto.components.automations.AutomationRunActions.applyFailed',
        'Failed: {reason}',
        { reason: outcome.reason }
      )
    case 'unknown':
      return translate(
        'auto.components.automations.AutomationRunActions.sent',
        'Sent · run {number}',
        { number }
      )
  }
}

type AutomationRunActionsProps = {
  sourceTarget?: AutomationHostTarget
  ownerRef?: AutomationOwnerRef | null
  automation: Automation
  run: AutomationRun
  runs: AutomationRun[]
  runNowAvailability: AutomationTargetAvailability | null
}

export function AutomationRunActions(props: AutomationRunActionsProps) {
  const output = props.automation.structuredOutput
  if (output?.provider === 'typesafe' && output.contract === 'advertising.v1') {
    return <TypesafeAdvertisingActions key={props.run.id} {...props} />
  }
  if (output?.provider === 'typesafe' && output.contract === 'classification.v1') {
    return <TypesafeClassificationResult {...props} />
  }
  return <LegacyAutomationRunActions {...props} />
}

function LegacyAutomationRunActions({
  automation,
  run,
  runs,
  runNowAvailability,
  sourceTarget
}: AutomationRunActionsProps) {
  const { actions, recommendations } = getAutomationRunMessage(run)
  const [sent, setSent] = useState<Record<string, number | null>>({})
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(false)
  // Why: the list folds only once every action is sent; applying one must keep the rest
  // in reach (Sal, 2026-09-20: "when I click 1 pause it collapses all the pauses"). Null
  // means "not chosen by the person", so the fold is automatic until they toggle it.
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null)
  const submitting = useRef(false)
  const outcomes = readAutomationApplyOutcomes(run, runs, actions)
  for (const [id, runNumber] of Object.entries(sent)) {
    if (!outcomes.has(id)) {
      outcomes.set(id, { state: 'verifying', runNumber })
    }
  }
  if (recommendations !== 'ready' && recommendations !== 'unreadable') {
    return null
  }
  const sentCount = actions.filter((action) => outcomes.has(action.id)).length
  const allSent = actions.length > 0 && sentCount === actions.length
  const collapsed = collapsedChoice ?? allSent
  const disabled = pending || runNowAvailability?.canRunNow === false
  const apply = async (chosen: AutomationAction[]) => {
    if (submitting.current || disabled || !chosen.length) {
      return
    }
    submitting.current = true
    setPending(true)
    setFailure(false)
    try {
      const next = await runAutomationNowForTarget(automation, sourceTarget, {
        prompt: buildAutomationApplyPrompt(chosen, automation.prompt),
        titleSuffix: `apply ${chosen.map((action) => action.id).join(',')}`
      })
      setSent((previous) => ({
        ...previous,
        ...Object.fromEntries(chosen.map((action) => [action.id, next.runNumber ?? null]))
      }))
    } catch {
      setFailure(true)
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <div className="mb-4 space-y-3">
      {recommendations === 'unreadable' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationRunActions.parseError',
            'Recommendations could not be read from this run.'
          )}
        </p>
      ) : null}
      {actions.length ? (
        <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => setCollapsedChoice(!collapsed)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left text-sm font-medium hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {collapsed ? (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span>
                {translate(
                  'auto.components.automations.AutomationRunActions.heading',
                  'Recommended actions'
                )}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {translate(
                  'auto.components.automations.AutomationRunActions.summary',
                  '{count} · {sent} sent',
                  {
                    count: actions.length,
                    sent: sentCount
                  }
                )}
              </span>
            </button>
            {pending ? <Loader2 className="size-4 motion-safe:animate-spin" /> : null}
            {collapsed
              ? null
              : (['pause', 'activate'] as const).map((kind) => {
                  const group = actions.filter((action) => action.kind === kind)
                  const available = group.filter((action) => !outcomes.has(action.id))
                  return group.length >= 2 ? (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      disabled={disabled || !available.length}
                      onClick={() => void apply(available)}
                    >
                      {kind === 'pause'
                        ? translate(
                            'auto.components.automations.AutomationRunActions.allPauses',
                            'Apply all pauses ({count})',
                            {
                              count: available.length
                            }
                          )
                        : translate(
                            'auto.components.automations.AutomationRunActions.allActivations',
                            'Apply all turn-ons ({count})',
                            {
                              count: available.length
                            }
                          )}
                    </Button>
                  ) : null
                })}
          </div>
          {collapsed
            ? null
            : actions.map((action) => {
                const outcome = outcomes.get(action.id)
                return (
                  <div key={action.id} className="flex items-center gap-3">
                    <Badge
                      variant="outline"
                      className={
                        action.kind === 'pause'
                          ? 'border-status-warning-border bg-status-warning-background text-status-warning'
                          : 'border-status-success-border bg-status-success-background text-status-success'
                      }
                    >
                      {kindLabel(action.kind)}
                    </Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <p>{action.label}</p>
                      {action.reason ? (
                        <p className="text-xs text-muted-foreground">{action.reason}</p>
                      ) : null}
                      {action.impact ? (
                        <p className="text-xs text-muted-foreground">{action.impact}</p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || outcome !== undefined}
                      onClick={() => void apply([action])}
                    >
                      {outcome ? outcomeLabel(action.kind, outcome) : kindLabel(action.kind)}
                    </Button>
                  </div>
                )
              })}
          {!collapsed && runNowAvailability?.canRunNow === false ? (
            <p className="text-xs text-muted-foreground">{runNowAvailability.message}</p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs text-muted-foreground">
              {translate(
                'auto.components.automations.AutomationRunActions.failed',
                'Could not send actions. Try again.'
              )}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
