import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { BoundAdvertisingDecision } from '../../../../shared/typesafe-advertising'
import {
  typedAdvertisingActionPreview,
  typedAdvertisingActionReceipt,
  type TypedAdvertisingActionPreview,
  type TypedAdvertisingActionReceipt
} from '../../../../shared/advertising-action-provider-contract'
import type { AutomationHostTarget } from './automation-host-client'
import { ownerPrecondition } from './automation-scoped-list-client'
import { TypesafeAdvertisingPreview } from './TypesafeAdvertisingPreview'

type Props = {
  decision: BoundAdvertisingDecision
  actionLabel: string
  automationId: string
  runId: string
  target: AutomationHostTarget
  ownerRef?: AutomationOwnerRef | null
  disabled: boolean
}

function matchesDecision(
  preview: TypedAdvertisingActionReceipt['preview'],
  decision: BoundAdvertisingDecision
): boolean {
  const matchesTarget =
    (preview.protocol_version === 'local-human-action.v1') ===
      (decision.evidence.source === 'local.meta.graph') &&
    (preview.protocol_version !== 'local-human-action.v1' || preview.decision_id === decision.id) &&
    preview.target.company === decision.target.company &&
    preview.target.type === decision.target.objectType &&
    preview.target.id === decision.target.nativeId &&
    preview.verb === (decision.kind === 'PAUSE' ? 'pause' : 'resume')
  if (!matchesTarget || !('snapshot' in preview)) {
    return matchesTarget
  }
  return (
    preview.snapshot.adAccountId === decision.target.accountId &&
    (decision.target.objectType === 'campaign' ||
      preview.snapshot.campaignId === decision.target.campaignId) &&
    (decision.target.objectType !== 'ad' || preview.snapshot.parentId === decision.target.adsetId)
  )
}

export function TypesafeAdvertisingActionControls({
  decision,
  actionLabel,
  automationId,
  runId,
  target,
  ownerRef,
  disabled
}: Props) {
  const [preview, setPreview] = useState<TypedAdvertisingActionPreview | null>(null)
  const [receipt, setReceipt] = useState<TypedAdvertisingActionReceipt | null>(null)
  const [approved, setApproved] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [pending, setPending] = useState<'preview' | 'execute' | 'verify' | null>(null)
  const [visiblePending, setVisiblePending] = useState(false)
  const [failure, setFailure] = useState(false)
  const [expired, setExpired] = useState(false)
  const inFlight = useRef(false)
  const executionAttempted = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    setVisiblePending(false)
    if (!pending) {
      return
    }
    const timer = setTimeout(() => setVisiblePending(true), 200)
    return () => clearTimeout(timer)
  }, [pending])
  useEffect(() => {
    const remaining = preview ? Date.parse(preview.expires_at) - Date.now() : 0
    setExpired(Boolean(preview) && remaining <= 0)
    if (!preview || remaining <= 0) {
      return
    }
    const timer = setTimeout(() => {
      setExpired(true)
      setApproved(false)
    }, remaining)
    return () => clearTimeout(timer)
  }, [preview])

  const verification = receipt?.execution?.verification
  const localStatusProposal = decision.evidence.source === 'local.meta.graph'
  const verified =
    receipt?.status === 'verified' &&
    verification?.status === 'verified' &&
    Boolean(verification.source.trim() && verification.version?.trim())
  const params = {
    automationId,
    runId,
    decisionId: decision.id,
    expectedOwner: ownerRef ? ownerPrecondition(ownerRef) : undefined
  }
  const options = {
    timeoutMs: 30_000,
    expectedEnvironmentPairingRevision:
      ownerRef?.authority.kind === 'runtime' ? ownerRef.authority.pairingRevision : undefined
  }
  const perform = async (operation: 'preview' | 'execute' | 'verify') => {
    if (!ownerRef || inFlight.current || verified || (disabled && operation !== 'verify')) {
      return
    }
    if (
      operation === 'execute' &&
      (executionAttempted.current ||
        !preview ||
        !approved ||
        expired ||
        Date.parse(preview.expires_at) <= Date.now())
    ) {
      return
    }
    if (operation === 'preview' && executionAttempted.current) {
      return
    }
    inFlight.current = true
    setPending(operation)
    setFailure(false)
    if (operation === 'execute') {
      executionAttempted.current = true
      setAttempted(true)
      setApproved(false)
    }
    try {
      if (operation === 'preview') {
        setPreview(null)
        setApproved(false)
        const response = await callRuntimeRpc<{ preview: unknown }>(
          target,
          'automation.advertising.preview',
          params,
          options
        )
        const next = typedAdvertisingActionPreview.parse(response.preview)
        if (
          !matchesDecision(next, decision) ||
          next.transition.from === next.transition.to ||
          (next.protocol_version === 'local-human-action.v1' &&
            (next.routine_id !== automationId || next.run_id !== runId))
        ) {
          throw new Error('Invalid advertising preview')
        }
        if (active.current) {
          setPreview(next)
        }
      } else {
        const response = await callRuntimeRpc<{ receipt: unknown }>(
          target,
          `automation.advertising.${operation}`,
          operation === 'execute'
            ? {
                ...params,
                previewId: preview!.id,
                expectedRevision: preview!.revision,
                approved: true
              }
            : params,
          options
        )
        const next = typedAdvertisingActionReceipt.parse(response.receipt)
        if (
          !matchesDecision(next.preview, decision) ||
          (next.preview.protocol_version === 'local-human-action.v1' &&
            (next.preview.routine_id !== automationId || next.preview.run_id !== runId)) ||
          (preview &&
            executionAttempted.current &&
            (next.id !== preview.id || next.preview.revision !== preview.revision))
        ) {
          throw new Error('Invalid advertising receipt')
        }
        if (active.current) {
          setReceipt(next)
          const hasAttempt =
            executionAttempted.current || next.status !== 'preview' || next.execution !== null
          executionAttempted.current = hasAttempt
          setAttempted(hasAttempt)
          setApproved(false)
        }
      }
    } catch {
      if (active.current) {
        setFailure(true)
      }
    } finally {
      inFlight.current = false
      if (active.current) {
        setPending(null)
      }
    }
  }

  return (
    <div className="space-y-3">
      {!ownerRef ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.ownerRequired',
            'Refresh the host connection before previewing or checking this action.'
          )}
        </p>
      ) : null}
      {verified ? (
        <p role="status" className="text-xs text-status-success">
          {localStatusProposal
            ? translate(
                'auto.components.automations.TypesafeAdvertisingActions.localVerified',
                'Target state verified by local Meta readback. Causality is unproven; delivery and profit are not guaranteed.'
              )
            : translate(
                'auto.components.automations.TypesafeAdvertisingActions.verified',
                '{{action}} verified · Source: {{source}} · Version: {{version}}',
                {
                  action: actionLabel,
                  source: verification!.source,
                  version: verification!.version
                }
              )}
        </p>
      ) : (
        <>
          {!attempted ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!ownerRef || disabled || Boolean(pending)}
              onClick={() => void perform('preview')}
            >
              {localStatusProposal
                ? translate(
                    'auto.components.automations.TypesafeAdvertisingActions.reviewLocalStatus',
                    'Review status action'
                  )
                : translate(
                    'auto.components.automations.TypesafeAdvertisingActions.preview',
                    'Preview {{action}}',
                    { action: actionLabel }
                  )}
            </Button>
          ) : null}
          {preview && !attempted ? (
            <div className="space-y-3 rounded-md border bg-card p-3 text-card-foreground">
              <TypesafeAdvertisingPreview preview={preview} />
              {expired ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.automations.TypesafeAdvertisingActions.expired',
                    'This preview expired. Preview the action again before confirming.'
                  )}
                </p>
              ) : (
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={approved}
                    disabled={!ownerRef || disabled || Boolean(pending)}
                    onCheckedChange={(value) => setApproved(value === true)}
                  />
                  <span>
                    {translate(
                      'auto.components.automations.TypesafeAdvertisingActions.consent',
                      'I approve this exact action: {{summary}} ({{id}}) in account {{account}}.',
                      {
                        summary: preview.summary,
                        id: decision.target.nativeId,
                        account: decision.target.accountId
                      }
                    )}
                  </span>
                </label>
              )}
              <Button
                size="sm"
                disabled={!ownerRef || disabled || Boolean(pending) || !approved || expired}
                onClick={() => void perform('execute')}
              >
                {translate(
                  'auto.components.automations.TypesafeAdvertisingActions.confirm',
                  'Confirm {{action}}',
                  { action: actionLabel }
                )}
              </Button>
            </div>
          ) : null}
          {attempted ? (
            <p role="status" className="text-xs text-muted-foreground">
              {receipt?.status === 'not_issued'
                ? translate(
                    'auto.components.automations.TypesafeAdvertisingActions.notIssued',
                    'Action not issued. No verified change.'
                  )
                : translate(
                    'auto.components.automations.TypesafeAdvertisingActions.unverified',
                    'Action unverified. Check the recorded action for source confirmation.'
                  )}
            </p>
          ) : null}
          {verification ? (
            <p className="break-words text-xs text-muted-foreground">
              {translate(
                'auto.components.automations.TypesafeAdvertisingActions.verificationSource',
                'Verification: {{status}} · Source: {{source}} · Version: {{version}}',
                {
                  status: verification.status,
                  source: verification.source,
                  version: verification.version
                }
              )}
            </p>
          ) : null}
          {receipt?.execution?.error ? (
            <p role="alert" className="text-xs text-muted-foreground">
              {receipt.execution.error.message}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!ownerRef || Boolean(pending)}
            onClick={() => void perform('verify')}
          >
            {translate(
              'auto.components.automations.TypesafeAdvertisingActions.checkRecorded',
              'Check recorded action'
            )}
          </Button>
        </>
      )}
      <div className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {visiblePending && pending === 'preview'
          ? translate(
              'auto.components.automations.TypesafeAdvertisingActions.previewing',
              'Loading the current action preview…'
            )
          : visiblePending && pending === 'execute'
            ? translate(
                'auto.components.automations.TypesafeAdvertisingActions.submitting',
                'Submitting approved action…'
              )
            : visiblePending && pending === 'verify'
              ? translate(
                  'auto.components.automations.TypesafeAdvertisingActions.checking',
                  'Checking source verification…'
                )
              : null}
      </div>
      {failure ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {attempted
            ? translate(
                'auto.components.automations.TypesafeAdvertisingActions.uncertain',
                'The action could not be verified. Check the recorded action before taking another action.'
              )
            : translate(
                'auto.components.automations.TypesafeAdvertisingActions.requestFailed',
                'The host could not confirm this request. No verified change.'
              )}
        </p>
      ) : null}
    </div>
  )
}
