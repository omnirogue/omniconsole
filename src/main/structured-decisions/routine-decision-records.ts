import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import {
  advertisingDecisionEnvelope,
  type AdvertisingDecisionEnvelope
} from '../../shared/typesafe-advertising'
import { routineStructuredResultSchema } from '../../shared/routine-structured-result'
import {
  typedAdvertisingActionPreview,
  typedAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import type { AdvertisingActionBinding } from '../automations/typesafe-advertising-actions'
import type { DecisionRecords } from './decision-records'
import type { Store } from '../persistence'
import { automationStructuredOutputSchema } from '../../shared/automation-structured-output'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'

export const storedAdvertising = z
  .object({ source: z.string(), envelope: advertisingDecisionEnvelope })
  .strict()
export const storedClassification = z
  .object({ source: z.string(), result: routineStructuredResultSchema })
  .strict()
export const actionBindingSchema: z.ZodType<AdvertisingActionBinding> = z
  .object({
    automationId: z.string(),
    runId: z.string(),
    decisionId: z.string(),
    principal: z.string(),
    sourceRevision: z.string(),
    idempotencyKey: z.string(),
    preview: typedAdvertisingActionPreview,
    submitted: z.boolean(),
    submittedAt: z.string().datetime({ offset: true }).optional(),
    receipt: typedAdvertisingActionReceipt.nullable()
  })
  .strict()
  .refine(
    (binding) =>
      binding.preview.protocol_version !== 'local-human-action.v1' ||
      !binding.submitted ||
      binding.submittedAt !== undefined,
    'Submitted local actions require their durable submission timestamp.'
  )
  .refine((binding) => {
    const preview = binding.preview
    if (preview.protocol_version !== 'local-human-action.v1') {
      return binding.receipt?.preview.protocol_version !== 'local-human-action.v1'
    }
    return (
      preview.routine_id === binding.automationId &&
      preview.run_id === binding.runId &&
      preview.decision_id === binding.decisionId &&
      preview.principal === binding.principal &&
      preview.source_revision === binding.sourceRevision &&
      (binding.receipt === null ||
        (binding.receipt.preview.protocol_version === 'local-human-action.v1' &&
          binding.receipt.id === preview.id &&
          binding.receipt.preview.revision === preview.revision))
    )
  }, 'The local action record must preserve its exact reviewed authority and decision.')

export function routineDecisionSourceRevision(automation: Automation, run: AutomationRun): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        configuration: automation.structuredOutput,
        prompt: automation.prompt,
        executionTarget: [
          automation.executionTargetType,
          automation.executionTargetId,
          automation.executionTargetGeneration
        ],
        run: [run.id, run.automationId, run.outputSnapshot]
      })
    )
    .digest('hex')
}

export function readRoutineDecisionSource(store: Store, routineId: string, runId: string) {
  const automation = store.listAutomations().find((row) => row.id === routineId)
  const run = store.listAutomationRuns(routineId).find((row) => row.id === runId)
  if (!automation || !run || run.status !== 'completed' || !run.outputSnapshot) {
    throw new Error('A completed routine run with captured output is required.')
  }
  if (
    automation.executionTargetType !== 'local' ||
    store.automationOwnerPrecondition(routineId)?.selector.kind !== 'self'
  ) {
    throw new Error('Structured decisions must run on the routine execution host.')
  }
  const settings = automationStructuredOutputSchema.safeParse(automation.structuredOutput)
  if (!settings.success) {
    throw new Error('Structured decisions are not enabled for this routine.')
  }
  if (run.outputSnapshot.provenance !== 'assistant_message') {
    throw new Error(
      'A confirmed current-turn final assistant response is required for structured decisions.'
    )
  }
  return {
    automation,
    run,
    settings: settings.data,
    source: routineDecisionSourceRevision(automation, run)
  }
}

export async function readAdvertisingDecision(
  records: DecisionRecords,
  routineId: string,
  runId: string,
  currentSource?: () => string
): Promise<AdvertisingDecisionEnvelope | null> {
  try {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      return null
    }
    const saved = await records.read(
      'result',
      `${routineId}:${runId}:advertising`,
      storedAdvertising
    )
    if (
      !saved ||
      saved.envelope.routineId !== routineId ||
      saved.envelope.runId !== runId ||
      saved.envelope.principal !== captured.data.principal ||
      !captured.data.isCurrent()
    ) {
      return null
    }
    return !currentSource || saved.source === currentSource() ? saved.envelope : null
  } catch {
    return null
  }
}

export function advertisingObjectRecordKey(accountId: string, nativeId: string): string {
  return `native-object:${accountId}:${nativeId}`
}

export async function readAdvertisingObjectAction(
  records: DecisionRecords,
  accountId: string,
  nativeId: string
): Promise<AdvertisingActionBinding | null> {
  const binding = await records.read(
    'action',
    advertisingObjectRecordKey(accountId, nativeId),
    actionBindingSchema,
    { failClosed: true }
  )
  if (
    binding &&
    (!binding.submitted ||
      binding.preview.protocol_version !== 'local-human-action.v1' ||
      binding.preview.snapshot.adAccountId !== accountId ||
      binding.preview.snapshot.objectId !== nativeId)
  ) {
    throw new Error('The durable native object reservation names a different submitted action.')
  }
  return binding
}

export async function hasUnresolvedAdvertisingAction(
  records: DecisionRecords,
  envelope: AdvertisingDecisionEnvelope
): Promise<boolean> {
  for (const decision of envelope.decisions) {
    let action = await records.read('action', decision.id, actionBindingSchema, {
      failClosed: true
    })
    if (decision.evidence.source === 'local.meta.graph') {
      const reservation = await readAdvertisingObjectAction(
        records,
        decision.target.accountId,
        decision.target.nativeId
      )
      if (reservation?.submitted && reservation.decisionId === decision.id) {
        action = reservation
      }
    }
    if (
      action?.submitted &&
      action.automationId === envelope.routineId &&
      action.runId === envelope.runId &&
      action.decisionId === decision.id &&
      action.principal === envelope.principal &&
      action.sourceRevision === envelope.sourceRevision &&
      !['verified', 'not_issued'].includes(action.receipt?.status ?? '')
    ) {
      return true
    }
  }
  return false
}
