import {
  isLaunchUuid,
  isLaunchPaneKey,
  isLaunchTerminalHandle,
  isLaunchRequestId,
  isLaunchReferenceId
} from './launch-identifiers'
import { isLaunchTrigger, normalizeLaunchTrigger, type LaunchTrigger } from './launch-trigger'

export const LAUNCH_PROVENANCE_CAPABILITY = 'terminal.launch-provenance.v1' as const

export const LAUNCH_REFERENCE_KEYS = [
  'automationId',
  'automationRunId',
  'orchestrationTaskId',
  'orchestrationDispatchId',
  'orchestrationRunId',
  'outcomeChainId',
  'workflowRunId',
  'recoveryId',
  'transferId',
  'sessionPrepBatchId',
  'agentSessionId',
  'buildReviewRunId',
  'consoleJobId'
] as const
export type LaunchReference = Partial<Record<(typeof LAUNCH_REFERENCE_KEYS)[number], string>>
export type LaunchActor = {
  kind: 'local-cli' | 'paired-device' | 'mobile' | 'app' | 'renderer'
  deviceId?: string
  clientKind?: 'mobile' | 'runtime'
  paneKey?: string
  terminalHandle?: string
  unverifiedPaneKey?: string
  unverifiedTerminalHandle?: string
}
export type LaunchCause = {
  trigger: LaunchTrigger
  reference?: LaunchReference
  actor?: LaunchActor
  requestId?: string
  requestIdHash?: string
  clientMutationIdHash?: string
  claimedTrigger?: LaunchTrigger
  claimedTriggerHash?: string
  claimedReference?: LaunchReference
  claimedReferenceHashes?: LaunchReference
  parentPaneKey?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Fixed keys and bounded identifiers only; metadata can never fail a launch. */
export function normalizeLaunchCause(value: unknown): LaunchCause {
  try {
    const input = record(value)
    const cause: LaunchCause = { trigger: normalizeLaunchTrigger(input?.trigger) }
    if (!input) {
      return cause
    }
    const referenceInput = record(input.reference)
    const reference: LaunchReference = {}
    for (const key of LAUNCH_REFERENCE_KEYS) {
      const id = referenceInput?.[key]
      if (isLaunchReferenceId(key, id)) {
        reference[key] = id
      }
    }
    if (Object.keys(reference).length) {
      cause.reference = reference
    }
    const claimedReferenceInput = record(input.claimedReference)
    const claimedReference: LaunchReference = {}
    for (const key of LAUNCH_REFERENCE_KEYS) {
      const id = claimedReferenceInput?.[key]
      if (isLaunchReferenceId(key, id)) {
        claimedReference[key] = id
      }
    }
    if (Object.keys(claimedReference).length) {
      cause.claimedReference = claimedReference
    }
    const referenceHashesInput = record(input.claimedReferenceHashes)
    const referenceHashes: LaunchReference = {}
    for (const key of LAUNCH_REFERENCE_KEYS) {
      const hash = referenceHashesInput?.[key]
      if (typeof hash === 'string' && /^hash_[0-9a-f]{12}$/.test(hash)) {
        referenceHashes[key] = hash
      }
    }
    if (Object.keys(referenceHashes).length) {
      cause.claimedReferenceHashes = referenceHashes
    }
    if (isLaunchTrigger(input.claimedTrigger)) {
      cause.claimedTrigger = input.claimedTrigger
    }
    for (const key of ['requestIdHash', 'clientMutationIdHash', 'claimedTriggerHash'] as const) {
      const hash = input[key]
      if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) {
        cause[key] = hash
      }
    }
    const actor = record(input.actor)
    if (
      actor &&
      typeof actor.kind === 'string' &&
      ['local-cli', 'paired-device', 'mobile', 'app', 'renderer'].includes(actor.kind)
    ) {
      cause.actor = { kind: actor.kind as LaunchActor['kind'] }
      for (const key of [
        'deviceId',
        'paneKey',
        'terminalHandle',
        'unverifiedPaneKey',
        'unverifiedTerminalHandle'
      ] as const) {
        const id = actor[key]
        const valid =
          key === 'deviceId'
            ? isLaunchUuid(id)
            : key.endsWith('PaneKey') || key === 'paneKey'
              ? isLaunchPaneKey(id)
              : isLaunchTerminalHandle(id)
        if (valid) {
          cause.actor[key] = id as string
        }
      }
      if (actor.clientKind === 'mobile' || actor.clientKind === 'runtime') {
        cause.actor.clientKind = actor.clientKind
      }
    }
    for (const key of ['requestId', 'parentPaneKey'] as const) {
      if (key === 'requestId' ? isLaunchRequestId(input[key]) : isLaunchPaneKey(input[key])) {
        cause[key] = input[key] as string
      }
    }
    return cause
  } catch {
    return { trigger: 'unknown' }
  }
}
