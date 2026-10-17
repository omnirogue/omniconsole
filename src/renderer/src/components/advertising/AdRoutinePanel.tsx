import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Figure } from '@/components/companies/CompaniesNotice'
import { translate } from '@/i18n/i18n'
import { ageLabel, money, percent, stamp } from './advertising-format'
import type { RoutineContext } from './advertising-model'
import type { AdvertisingDecisionRow } from '../../../../shared/console-advertising-contract'

const MODE_LABEL: Record<RoutineContext['mode'], () => string> = {
  auto: () => translate('advertising.modeAuto', 'Acting automatically'),
  recommend: () => translate('advertising.modeRecommend', 'Recommending only'),
  paused: () => translate('advertising.modePaused', 'Paused'),
  unconfigured: () => translate('advertising.modeUnconfigured', 'Not configured')
}

/**
 * A decision the routine proposed or took, with its probability shown ONLY as an
 * estimate: the number, its credible interval and its calibration status travel
 * together, and an uncalibrated estimate says so on its face.
 */
function DecisionRow({ row }: { row: AdvertisingDecisionRow }): React.JSX.Element {
  const interval = row.credible_interval
  const calibration = row.calibration_status
  return (
    <li className="space-y-1 border-t py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-medium">{row.action}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{row.name}</span>
        {row.level ? (
          <Badge variant="secondary" className="text-[10px] font-normal">
            {row.level}
          </Badge>
        ) : null}
        {row.status ? (
          <Badge variant="outline" className="text-[10px] font-normal">
            {row.status}
          </Badge>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{row.reason}</p>
      {row.probability !== null ? (
        <p className="text-[11px]">
          <span className="font-medium">
            {translate('advertising.estimatedProbability', 'Estimated probability {{value}}', {
              value: percent(row.probability)
            })}
          </span>
          {interval
            ? ` · ${translate('advertising.credibleInterval', 'credible {{low}} to {{high}}', {
                low: percent(interval[0]),
                high: percent(interval[1])
              })}`
            : ` · ${translate('advertising.noInterval', 'no interval: evidence insufficient')}`}
          {' · '}
          <span
            className={calibration === 'calibrated' ? '' : 'text-amber-700 dark:text-amber-400'}
          >
            {calibration === 'calibrated'
              ? translate('advertising.calibrated', 'calibrated')
              : calibration === 'provisional'
                ? translate('advertising.provisional', 'provisional calibration')
                : translate('advertising.uncalibrated', 'not calibrated — treat as a guess')}
          </span>
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {translate('advertising.basis', 'Basis: {{basis}}', { basis: row.basis })}
        {row.observed_at
          ? ` · ${translate('advertising.evidenceObserved', 'evidence observed {{when}}', {
              when: stamp(row.observed_at)
            })}`
          : ` · ${translate('advertising.evidenceTimeUnknown', 'evidence time not reported')}`}
      </p>
      {row.uncertainty.length > 0 ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {translate('advertising.uncertainty', 'Uncertainty: {{list}}', {
            list: row.uncertainty.join('; ')
          })}
        </p>
      ) : null}
      {row.blockers.length > 0 ? (
        <p className="text-[11px] text-rose-600 dark:text-rose-400">
          {translate('advertising.blockers', 'Blocked by: {{list}}', {
            list: row.blockers.join('; ')
          })}
        </p>
      ) : null}
    </li>
  )
}

/**
 * The routine context behind the ad result. Its last evaluation is NOT a live
 * provider read, so the time it last ran, the age of the observation it ran on,
 * and whether its coverage was complete are all stated separately from the money.
 */
export function AdRoutinePanel({
  context,
  decisions,
  note
}: {
  context: RoutineContext | null
  decisions: readonly AdvertisingDecisionRow[]
  note: string | null
}): React.JSX.Element {
  if (!context) {
    return (
      <section
        className="rounded-xl border bg-card p-4"
        aria-label={translate('advertising.routineRegion', 'Advertising routine')}
      >
        <h3 className="text-sm font-semibold">
          {translate('advertising.routine', 'Routine behind these numbers')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {note ??
            translate(
              'advertising.routineUnavailable',
              'No single account coordinator answered for this company, so its context is unavailable. The figures above come straight from the provider report.'
            )}
        </p>
      </section>
    )
  }
  const stale = context.insightsAgeSeconds !== null && context.insightsAgeSeconds > 3 * 3600
  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-label={translate('advertising.routineRegion', 'Advertising routine')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('advertising.routine', 'Routine behind these numbers')}
        </h3>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge
            variant={context.mode === 'auto' ? 'secondary' : 'outline'}
            className="text-[10px]"
          >
            {MODE_LABEL[context.mode]()}
          </Badge>
          {context.accountState ? <span>{context.accountState}</span> : null}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure
          label={translate('advertising.spendTodayRoutine', 'Spend today (routine)')}
          value={money(context.spendToday, context.currency ?? 'USD')}
        />
        {/* Active budget is an allowance, not money that moved. */}
        <Figure
          label={translate('advertising.activeBudget', 'Active daily budget')}
          value={money(context.activeDailyBudget, context.currency ?? 'USD')}
        />
        <Figure
          label={translate('advertising.limitRemaining', 'Spending limit left')}
          value={money(context.spendingLimitRemaining, context.currency ?? 'USD')}
        />
        <Figure
          label={translate('advertising.objectsEvaluated', 'Objects evaluated')}
          value={context.evaluated}
        />
      </dl>
      <p className="text-[11px] text-muted-foreground">
        {translate('advertising.lastEvaluated', 'Last evaluated {{when}}', {
          when: stamp(context.lastEvaluatedAt)
        })}
        {' · '}
        <span className={stale ? 'text-amber-700 dark:text-amber-400' : undefined}>
          {translate('advertising.observationAge', 'provider observation {{age}}', {
            age: ageLabel(context.insightsAgeSeconds)
          })}
        </span>
        {context.nextDueAt
          ? ` · ${translate('advertising.nextDue', 'next due {{when}}', {
              when: stamp(context.nextDueAt)
            })}`
          : ''}
        {context.coverageComplete === false
          ? ` · ${translate('advertising.coveragePartial', 'coverage incomplete for this cycle')}`
          : ''}
      </p>
      {context.probabilityModelCalibrated === false ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {translate(
            'advertising.modelUncalibrated',
            'The probability model is not calibrated for this account. Every estimate below is uncalibrated.'
          )}
        </p>
      ) : null}
      {context.errors.length > 0 ? (
        <ul
          role="alert"
          className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2"
        >
          {context.errors.slice(0, 4).map((error) => (
            <li key={error} className="text-[11px] text-amber-700 dark:text-amber-400">
              {error}
            </li>
          ))}
        </ul>
      ) : null}
      {decisions.length > 0 ? (
        <div>
          <h4 className="mb-1 text-xs font-medium">
            {translate('advertising.recentDecisions', 'What it decided')}
          </h4>
          <ul>
            {decisions.slice(0, 6).map((row) => (
              <DecisionRow key={row.id} row={row} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {translate('advertising.noDecisions', 'No decisions are recorded for this cycle.')}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'advertising.readOnlyNote',
          'This view reads only. Pausing, budgets and coordinator settings stay in OmniOS.'
        )}
      </p>
    </section>
  )
}
