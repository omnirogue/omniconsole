import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
import {
  advertisingDecisionEnvelope,
  type AdvertisingDecisionEnvelope
} from '../../../../shared/typesafe-advertising'
import { getAutomationOwnerTarget, type AutomationHostTarget } from './automation-host-client'
import type { AutomationTargetAvailability } from './automation-target-availability'
import { TypesafeAdvertisingDecision } from './TypesafeAdvertisingDecision'
import { ownerPrecondition } from './automation-scoped-list-client'

type Props = {
  automation: Automation
  run: AutomationRun
  sourceTarget?: AutomationHostTarget
  ownerRef?: AutomationOwnerRef | null
  runNowAvailability: AutomationTargetAvailability | null
}

export function TypesafeAdvertisingActions(props: Props) {
  const target = getAutomationOwnerTarget(props.automation, props.sourceTarget)
  const authorityKey = target.kind === 'environment' ? target.environmentId : 'local'
  return (
    <AdvertisingRun
      key={[
        authorityKey,
        props.ownerRef ? ownerKey(props.ownerRef) : 'unscoped',
        props.automation.id,
        props.run.id
      ]
        .map(encodeURIComponent)
        .join('|')}
      {...props}
      target={target}
    />
  )
}

function AdvertisingRun({
  automation,
  run,
  target,
  ownerRef,
  runNowAvailability
}: Props & { target: AutomationHostTarget }) {
  const [envelope, setEnvelope] = useState<AdvertisingDecisionEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const authority = ownerRef?.authority
    const ownerMatchesTarget =
      !authority ||
      (authority.kind === 'desktop'
        ? environmentId === null
        : authority.environmentId === environmentId)
    if (!ownerMatchesTarget || run.automationId !== automation.id) {
      setFailure(true)
      setLoading(false)
      return
    }
    setLoading(true)
    setFailure(false)
    void callRuntimeRpc<{ envelope: unknown }>(
      environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
      'automation.advertising.get',
      {
        automationId: automation.id,
        runId: run.id,
        expectedOwner: ownerRef ? ownerPrecondition(ownerRef) : undefined
      },
      {
        timeoutMs: 120_000,
        signal: controller.signal,
        expectedEnvironmentPairingRevision:
          authority?.kind === 'runtime' ? authority.pairingRevision : undefined
      }
    )
      .then((result) => {
        if (!active) {
          return
        }
        if (result.envelope === null) {
          setEnvelope(null)
          return
        }
        const parsed = advertisingDecisionEnvelope.safeParse(result.envelope)
        if (
          !parsed.success ||
          parsed.data.routineId !== automation.id ||
          parsed.data.runId !== run.id
        ) {
          setFailure(true)
          return
        }
        setEnvelope(parsed.data)
      })
      .catch(() => {
        if (active) {
          setFailure(true)
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
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
    refresh,
    ownerRef
  ])

  return (
    <section className="mb-4 space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.heading',
            'Advertising decisions'
          )}
        </h3>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.refresh',
            'Refresh decisions'
          )}
        </Button>
      </div>
      {loading && !envelope ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.loading',
            'Loading validated decisions…'
          )}
        </p>
      ) : failure ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.unavailable',
            'Validated advertising decisions are unavailable. Refresh to check the owning host.'
          )}
        </p>
      ) : !envelope ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.pending',
            'This run has no validated advertising decisions yet.'
          )}
        </p>
      ) : envelope.status === 'blocked' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {envelope.reason ||
            translate(
              'auto.components.automations.TypesafeAdvertisingActions.blocked',
              'Advertising decisions are blocked. No action is available.'
            )}
        </p>
      ) : (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {translate(
              'auto.components.automations.TypesafeAdvertisingActions.source',
              'Source: {{source}} · Version: {{revision}}',
              {
                source:
                  [...new Set(envelope.decisions.map((decision) => decision.evidence.source))].join(
                    ', '
                  ) ||
                  translate(
                    'auto.components.automations.TypesafeAdvertisingActions.unknownSource',
                    'Unknown'
                  ),
                revision: envelope.sourceRevision
              }
            )}
          </p>
          {envelope.decisions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.automations.TypesafeAdvertisingActions.empty',
                'No advertising decisions were returned.'
              )}
            </p>
          ) : (
            envelope.decisions.map((decision) => (
              <TypesafeAdvertisingDecision
                key={`${envelope.sourceRevision}:${decision.id}`}
                decision={decision}
                target={target}
                automationId={automation.id}
                runId={run.id}
                ownerRef={ownerRef}
                disabled={runNowAvailability?.canRunNow === false}
              />
            ))
          )}
        </>
      )}
      {runNowAvailability?.canRunNow === false ? (
        <p className="text-xs text-muted-foreground">{runNowAvailability.message}</p>
      ) : null}
    </section>
  )
}
