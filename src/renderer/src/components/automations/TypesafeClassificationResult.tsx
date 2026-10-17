import { useEffect, useState } from 'react'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
import {
  routineStructuredResultSchema,
  type RoutineStructuredResult
} from '../../../../shared/routine-structured-result'
import {
  getAutomationHostTargetKey,
  getAutomationOwnerTarget,
  type AutomationHostTarget
} from './automation-host-client'
import { ownerPrecondition } from './automation-scoped-list-client'

export type TypesafeClassificationResultProps = {
  automation: Automation
  run: AutomationRun
  sourceTarget?: AutomationHostTarget
  ownerRef?: AutomationOwnerRef | null
}

const responseSchema = z.object({ result: routineStructuredResultSchema.nullable() })
type ResultState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'loaded'; result: RoutineStructuredResult | null }

export function TypesafeClassificationResult(props: TypesafeClassificationResultProps) {
  const target = getAutomationOwnerTarget(props.automation, props.sourceTarget)
  const identity = [
    getAutomationHostTargetKey(target),
    props.ownerRef ? ownerKey(props.ownerRef) : 'unscoped',
    props.automation.id,
    props.run.id,
    props.run.status,
    String(props.run.outputSnapshot?.capturedAt ?? '')
  ]
    .map(encodeURIComponent)
    .join('|')
  return <ClassificationRun key={identity} {...props} target={target} />
}

function ClassificationRun({
  automation,
  run,
  target,
  ownerRef
}: TypesafeClassificationResultProps & { target: AutomationHostTarget }) {
  const [state, setState] = useState<ResultState>({ status: 'loading' })
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ status: 'loading' })
    const authority = ownerRef?.authority
    const ownerMatchesTarget =
      !authority ||
      (authority.kind === 'desktop'
        ? environmentId === null
        : authority.environmentId === environmentId)
    if (!ownerMatchesTarget || run.automationId !== automation.id) {
      setState({ status: 'unavailable' })
      return
    }
    void callRuntimeRpc<unknown>(
      environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
      'automation.structured.get',
      {
        automationId: automation.id,
        runId: run.id,
        ...(ownerRef ? { expectedOwner: ownerPrecondition(ownerRef) } : {})
      },
      {
        timeoutMs: 15_000,
        signal: controller.signal,
        ...(authority?.kind === 'runtime'
          ? { expectedEnvironmentPairingRevision: authority.pairingRevision }
          : {})
      }
    )
      .then((response) => {
        if (!active) {
          return
        }
        const parsed = responseSchema.safeParse(response)
        if (
          !parsed.success ||
          (parsed.data.result &&
            (parsed.data.result.routineId !== automation.id || parsed.data.result.runId !== run.id))
        ) {
          setState({ status: 'unavailable' })
          return
        }
        setState({ status: 'loaded', result: parsed.data.result })
      })
      .catch(() => {
        if (active) {
          setState({ status: 'unavailable' })
        }
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [
    automation.id,
    run.automationId,
    run.id,
    run.status,
    run.outputSnapshot?.capturedAt,
    environmentId,
    ownerRef
  ])

  const result = state.status === 'loaded' ? state.result : null
  const unknown = translate(
    'auto.components.automations.TypesafeClassificationResult.unknown',
    'Unknown'
  )
  const fields = result
    ? [
        ...(result.status === 'ready'
          ? [
              [
                translate(
                  'auto.components.automations.TypesafeClassificationResult.verdict',
                  'Verdict'
                ),
                result.verdict ?? unknown
              ],
              [
                translate(
                  'auto.components.automations.TypesafeClassificationResult.severity',
                  'Severity'
                ),
                result.severity ?? unknown
              ],
              [
                translate(
                  'auto.components.automations.TypesafeClassificationResult.confidence',
                  'Confidence'
                ),
                result.confidence === null
                  ? unknown
                  : new Intl.NumberFormat(undefined, {
                      style: 'percent',
                      maximumFractionDigits: 1
                    }).format(result.confidence)
              ]
            ]
          : []),
        [
          translate('auto.components.automations.TypesafeClassificationResult.source', 'Source'),
          `${result.provider || unknown} / ${result.model || unknown}`
        ],
        [
          translate('auto.components.automations.TypesafeClassificationResult.version', 'Version'),
          result.sourceRevision
        ],
        [
          translate(
            'auto.components.automations.TypesafeClassificationResult.evaluated',
            'Evaluated'
          ),
          new Date(result.evaluatedAt).toLocaleString()
        ]
      ]
    : []
  return (
    <section className="mb-4 space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <h3 className="text-sm font-medium">
        {translate(
          'auto.components.automations.TypesafeClassificationResult.heading',
          'Advisory result'
        )}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.automations.TypesafeClassificationResult.description',
          'Classification of this run’s reported output; it does not verify completion.'
        )}
      </p>
      {state.status === 'loading' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeClassificationResult.loading',
            'Loading advisory result…'
          )}
        </p>
      ) : state.status === 'unavailable' ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeClassificationResult.unavailable',
            'Advisory result is unavailable from the owning host.'
          )}
        </p>
      ) : !result ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeClassificationResult.pending',
            'This run has no advisory result yet.'
          )}
        </p>
      ) : result.status === 'blocked' ? (
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p>
            {translate(
              'auto.components.automations.TypesafeClassificationResult.blocked',
              'Advisory result is blocked.'
            )}
          </p>
          {result.reason ? <p>{result.reason}</p> : null}
        </div>
      ) : null}
      {fields.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {fields.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}
