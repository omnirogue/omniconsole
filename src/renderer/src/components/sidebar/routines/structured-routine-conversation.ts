import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import {
  getAutomationOwnerTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { ownerPrecondition } from '@/components/automations/automation-scoped-list-client'
import type { Automation, AutomationRun } from '../../../../../shared/automations-types'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../../shared/automation-owner-ref'
import { automationStructuredOutputSchema } from '../../../../../shared/automation-structured-output'

const ownerSchema = z
  .object({
    selector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('self') }).strict(),
      z
        .object({
          kind: z.literal('ssh'),
          targetId: z.string().trim().min(1),
          targetGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
        })
        .strict()
    ])
  })
  .strict()
const shownRoutineSchema = z.object({
  automation: z.object({
    id: z.string(),
    prompt: z.string(),
    executionTargetType: z.enum(['local', 'ssh']),
    executionTargetId: z.string(),
    executionTargetGeneration: z.number().int().positive().optional(),
    structuredOutput: automationStructuredOutputSchema
  }),
  owner: ownerSchema
})

export type StructuredRoutineConversation = {
  runs: AutomationRun[]
  ownerRef: AutomationOwnerRef
  sourceTarget: AutomationHostTarget
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Routine read cancelled.', 'AbortError')
  }
}

/** The sidebar's legacy list has no owner metadata; capture it from that same authority. */
export async function readStructuredRoutineConversation(
  automation: Automation,
  sourceTarget: AutomationHostTarget,
  signal: AbortSignal,
  ownerRef?: AutomationOwnerRef | null
): Promise<StructuredRoutineConversation> {
  assertActive(signal)
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  const settings = automationStructuredOutputSchema.parse(automation.structuredOutput)
  const capturedAuthority = ownerRef?.authority
  if (
    capturedAuthority &&
    (capturedAuthority.kind === 'desktop'
      ? target.kind !== 'local'
      : target.kind !== 'environment' || capturedAuthority.environmentId !== target.environmentId)
  ) {
    throw new Error('The routine owner no longer matches its source host.')
  }
  const pairingRevision =
    target.kind === 'environment'
      ? capturedAuthority?.kind === 'runtime'
        ? capturedAuthority.pairingRevision
        : captureRuntimeEnvironmentRequestRevision(target.environmentId)
      : undefined
  if (
    target.kind === 'environment' &&
    (pairingRevision === undefined || !Number.isSafeInteger(pairingRevision) || pairingRevision < 0)
  ) {
    throw new Error('The routine host pairing is unavailable.')
  }
  const options = {
    timeoutMs: 15_000,
    signal,
    ...(pairingRevision !== undefined
      ? { expectedEnvironmentPairingRevision: pairingRevision }
      : {})
  }
  let owner = ownerRef
  if (!owner) {
    const response = await callRuntimeRpc<unknown>(
      target,
      'automation.show',
      { id: automation.id },
      options
    )
    assertActive(signal)
    const shown = shownRoutineSchema.parse(response)
    if (
      shown.automation.id !== automation.id ||
      shown.automation.prompt !== automation.prompt ||
      shown.automation.executionTargetType !== automation.executionTargetType ||
      shown.automation.executionTargetId !== automation.executionTargetId ||
      shown.automation.executionTargetGeneration !== automation.executionTargetGeneration ||
      JSON.stringify(shown.automation.structuredOutput) !== JSON.stringify(settings)
    ) {
      throw new Error('The routine settings changed. Reopen the routine to read its results.')
    }
    const authority: AutomationAuthorityRef =
      target.kind === 'environment'
        ? {
            kind: 'runtime',
            environmentId: target.environmentId,
            pairingRevision: pairingRevision!
          }
        : { kind: 'desktop' }
    owner = { authority, selector: shown.owner.selector }
  }
  const expectedOwner = ownerSchema.parse(ownerPrecondition(owner))
  const history = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    { automationId: automation.id, expectedOwner },
    options
  )
  assertActive(signal)
  if (
    !history ||
    !Array.isArray(history.runs) ||
    history.runs.some(
      (run) =>
        !run ||
        run.automationId !== automation.id ||
        typeof run.id !== 'string' ||
        typeof run.title !== 'string' ||
        !Number.isFinite(run.createdAt)
    )
  ) {
    throw new Error('The routine history did not match the requested routine.')
  }
  return { runs: history.runs, ownerRef: owner, sourceTarget: target }
}
