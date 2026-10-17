import type { AdvertisingActionBinding } from '../automations/typesafe-advertising-actions'
import type { DecisionRecords } from './decision-records'
import {
  actionBindingSchema,
  advertisingObjectRecordKey,
  readAdvertisingObjectAction
} from './routine-decision-records'
export { readAdvertisingObjectAction } from './routine-decision-records'

/** The object reservation reaches durable storage before any decision can authorize a send. */
export async function writeAdvertisingActionBinding(
  records: DecisionRecords,
  input: AdvertisingActionBinding
): Promise<void> {
  const binding = actionBindingSchema.parse(input)
  if (binding.preview.protocol_version === 'local-human-action.v1' && binding.submitted) {
    const snapshot = binding.preview.snapshot
    const prior = await readAdvertisingObjectAction(
      records,
      snapshot.adAccountId,
      snapshot.objectId
    )
    if (
      prior?.submitted &&
      prior.decisionId === binding.decisionId &&
      (prior.preview.id !== binding.preview.id ||
        prior.preview.revision !== binding.preview.revision ||
        prior.idempotencyKey !== binding.idempotencyKey ||
        prior.submittedAt !== binding.submittedAt)
    ) {
      throw new Error('The native object reservation preserves a different submitted preview.')
    }
    if (
      prior?.submitted &&
      prior.decisionId !== binding.decisionId &&
      (!['verified', 'not_issued'].includes(prior.receipt?.status ?? '') ||
        binding.receipt !== null)
    ) {
      throw new Error('A different action retains the durable native object send fence.')
    }
    await records.write(
      'action',
      advertisingObjectRecordKey(snapshot.adAccountId, snapshot.objectId),
      binding,
      actionBindingSchema
    )
  }
  await records.write('action', binding.decisionId, binding, actionBindingSchema)
}
