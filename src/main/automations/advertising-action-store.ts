import {
  advertisingDecisionEnvelope,
  type AdvertisingDecisionEnvelope,
  type AdvertisingRoutinePolicy
} from '../../shared/typesafe-advertising'
import type {
  TypedAdvertisingActionPreview,
  TypedAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import type { LocalMetaActionScope } from './local-meta-action-authority'

export type AdvertisingActionSelection = { automationId: string; runId: string; decisionId: string }
export type AdvertisingActionBinding = AdvertisingActionSelection & {
  principal: string
  sourceRevision: string
  idempotencyKey: string
  preview: TypedAdvertisingActionPreview
  submitted: boolean
  submittedAt?: string
  receipt: TypedAdvertisingActionReceipt | null
}
export type AdvertisingActionStore = {
  loadEnvelope: (
    routineId: string,
    runId: string,
    options?: { verificationOnly?: boolean }
  ) => Promise<AdvertisingDecisionEnvelope | null>
  loadPolicy: (routineId: string) => Promise<AdvertisingRoutinePolicy | null>
  loadAction: (decisionId: string) => Promise<AdvertisingActionBinding | null>
  saveAction: (binding: AdvertisingActionBinding) => Promise<void>
  withRunLock?: <T>(routineId: string, runId: string, work: () => Promise<T>) => Promise<T>
  withObjectLock?: <T>(accountId: string, nativeId: string, work: () => Promise<T>) => Promise<T>
  loadObjectAction?: (
    accountId: string,
    nativeId: string
  ) => Promise<AdvertisingActionBinding | null>
  captureLocalScope?: (
    routineId: string,
    runId: string,
    verificationOnly: boolean
  ) => Omit<LocalMetaActionScope, 'target'>
}

export async function withAdvertisingSelectionObjectLock<T>(
  store: AdvertisingActionStore,
  selection: AdvertisingActionSelection,
  work: () => Promise<T>
): Promise<T> {
  const parsed = advertisingDecisionEnvelope.safeParse(
    await store.loadEnvelope(selection.automationId, selection.runId, { verificationOnly: true })
  )
  if (
    !parsed.success ||
    parsed.data.status !== 'ready' ||
    parsed.data.routineId !== selection.automationId ||
    parsed.data.runId !== selection.runId
  ) {
    throw new Error('The selected advertising decision is unavailable for action admission.')
  }
  const decision = parsed.data.decisions.find((item) => item.id === selection.decisionId)
  if (!decision) {
    throw new Error('The selected advertising decision is unavailable for action admission.')
  }
  if (decision.evidence.source !== 'local.meta.graph') {
    return work()
  }
  if (!store.withObjectLock) {
    throw new Error('The durable native object action lock is unavailable.')
  }
  return store.withObjectLock(decision.target.accountId, decision.target.nativeId, work)
}

export async function loadAdvertisingSelectionBinding(
  store: AdvertisingActionStore,
  selection: AdvertisingActionSelection
): Promise<AdvertisingActionBinding | null> {
  const saved = await store.loadAction(selection.decisionId)
  if (store.loadObjectAction) {
    const envelope = await store.loadEnvelope(selection.automationId, selection.runId, {
      verificationOnly: true
    })
    const decision = envelope?.decisions.find((item) => item.id === selection.decisionId)
    if (decision?.evidence.source === 'local.meta.graph') {
      const reservation = await store.loadObjectAction(
        decision.target.accountId,
        decision.target.nativeId
      )
      if (reservation?.submitted && reservation.decisionId === selection.decisionId) {
        return reservation
      }
    }
  }
  return saved
}

export async function assertAdvertisingObjectSendAvailable(
  store: AdvertisingActionStore,
  binding: AdvertisingActionBinding
): Promise<void> {
  if (binding.preview.protocol_version !== 'local-human-action.v1') {
    return
  }
  if (!store.loadObjectAction) {
    throw new Error('The durable native object send fence is unavailable.')
  }
  const prior = await store.loadObjectAction(
    binding.preview.snapshot.adAccountId,
    binding.preview.snapshot.objectId
  )
  if (
    prior?.submitted &&
    (prior.decisionId === binding.decisionId ||
      !['verified', 'not_issued'].includes(prior.receipt?.status ?? ''))
  ) {
    throw new Error(
      'A prior action on this native object is unconfirmed. Verify its recorded preview before requesting another action; it will not be resent.'
    )
  }
}
