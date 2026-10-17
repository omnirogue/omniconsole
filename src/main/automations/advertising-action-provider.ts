import type {
  AdvertisingDecisionEnvelope,
  BoundAdvertisingDecision
} from '../../shared/typesafe-advertising'
import type {
  TypedAdvertisingActionPreview,
  TypedAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import { consoleAdvertisingActionsClient } from '../backoffice/console-advertising-actions-client'
import type { LocalMetaActionScope } from './local-meta-action-authority'
import {
  executeLocalStatus,
  prepareLocalStatusPreview,
  verifyLocalStatus
} from './local-meta-status-provider'
import type { AdvertisingActionBinding } from './typesafe-advertising-actions'
import { targetFor, verbFor } from './typesafe-advertising-native-binding'
import { localAdvertisingActionReceipt } from '../../shared/advertising-action-provider-contract'

export type AdvertisingActionContext = {
  decision: BoundAdvertisingDecision
  envelope: AdvertisingDecisionEnvelope
  principal: string
  scope?: LocalMetaActionScope
  assertCurrent(): void | Promise<void>
}

function localContext(context: AdvertisingActionContext) {
  if (!context.scope || context.decision.evidence.source !== 'local.meta.graph') {
    throw new Error('The separate local advertising action authority is unavailable.')
  }
  return { ...context, scope: context.scope }
}

export async function prepareAdvertisingAction(
  context: AdvertisingActionContext
): Promise<TypedAdvertisingActionPreview> {
  if (context.decision.evidence.source === 'local.meta.graph') {
    return prepareLocalStatusPreview(localContext(context))
  }
  const result = await consoleAdvertisingActionsClient.preview(
    {
      target: targetFor(context.decision),
      verb: verbFor(context.decision),
      reason: context.decision.reasoningSummary
    },
    context.principal
  )
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}

export async function sendAdvertisingAction(
  context: AdvertisingActionContext,
  binding: AdvertisingActionBinding
): Promise<TypedAdvertisingActionReceipt> {
  if (binding.preview.protocol_version === 'local-human-action.v1') {
    if (!binding.submittedAt) {
      throw new Error('The local action submission timestamp is unavailable.')
    }
    return executeLocalStatus(localContext(context), {
      ...binding,
      submittedAt: binding.submittedAt,
      preview: binding.preview,
      receipt:
        binding.receipt === null ? null : localAdvertisingActionReceipt.parse(binding.receipt)
    })
  }
  if (context.decision.evidence.source === 'local.meta.graph') {
    throw new Error('Local advertising decisions cannot acquire signed backend authority.')
  }
  const result = await consoleAdvertisingActionsClient.execute(
    {
      id: binding.preview.id,
      target: targetFor(context.decision),
      verb: verbFor(context.decision),
      expected_revision: binding.preview.revision,
      idempotency_key: binding.idempotencyKey,
      approved: true
    },
    context.principal
  )
  if (!result.ok) {
    throw new Error(
      'The action result is unconfirmed. Check its recorded status before continuing.'
    )
  }
  return result.data
}

export async function verifyAdvertisingAction(
  context: AdvertisingActionContext,
  binding: AdvertisingActionBinding
): Promise<TypedAdvertisingActionReceipt> {
  if (binding.preview.protocol_version === 'local-human-action.v1') {
    if (!binding.submittedAt) {
      throw new Error('The local action submission timestamp is unavailable.')
    }
    return verifyLocalStatus(localContext(context), {
      ...binding,
      submittedAt: binding.submittedAt,
      preview: binding.preview,
      receipt:
        binding.receipt === null ? null : localAdvertisingActionReceipt.parse(binding.receipt)
    })
  }
  if (context.decision.evidence.source === 'local.meta.graph') {
    throw new Error('Local advertising decisions cannot acquire signed backend authority.')
  }
  const result = await consoleAdvertisingActionsClient.verify(
    {
      id: binding.preview.id,
      target: targetFor(context.decision),
      verb: verbFor(context.decision)
    },
    context.principal
  )
  if (!result.ok) {
    throw new Error('The native action could not be verified; it will not be resent.')
  }
  return result.data
}
